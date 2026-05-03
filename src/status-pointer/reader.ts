/**
 * Status-pointer reader — best-effort load of `~/.pi-comms/status-pointer.md`
 * for prepending to the system prompt under a `<previous-context>` envelope.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"Status pointer mechanism" (lines 220-249): file format is markdown
 *     with a header block ("Last updated: ...", "Daemon started: ...") followed
 *     by an opaque body. Total cap 2000 characters.
 *   - Pitfall #23 (line 1263): the body is attacker-influenceable -- sanitize
 *     prompt-section markers before letting the body anywhere near the system
 *     prompt envelope.
 *   - Data Guardian "Status pointer parser" (line 1327): the body parser is
 *     OPAQUE, not positional -- header until first blank line, body opaque.
 *     We expose the body as `raw` and only parse fixed header fields by name.
 *   - Data Guardian "2000-char grapheme cap" (line 1320): truncate by
 *     graphemes via `Intl.Segmenter`, NOT by bytes -- a byte cap can land
 *     mid-codepoint and corrupt UTF-8, and a code-unit cap can land between
 *     a base char and a combining mark and produce visually incorrect output.
 *
 * Read flow:
 *   1. Read the file. Missing -> return null.
 *   2. If the read raises a non-ENOENT error, surface it (caller decides).
 *   3. Detect "obviously binary garbage" by looking for U+0000 in the head
 *      -- markdown never contains NULs. If found, quarantine and return null.
 *   4. Sanitize via sanitizeForPromptInjection.
 *   5. Grapheme-aware truncate to maxGraphemes (default 2000).
 *   6. Parse header fields (regex per known label). Expose body raw + flags.
 *
 * The reader does NOT mutate the file (other than quarantining truly broken
 * input). Writes go through StatusPointerWriter.
 */

import { readFile, rename } from "node:fs/promises";

import { sanitizeForPromptInjection } from "../lib/sanitize.js";

/** Fixed header fields parsed from the top of status-pointer.md. */
export interface StatusPointerHeaderFields {
  /** "Last updated: <ISO>" -- set by either daemon or agent. */
  lastUpdated?: string;
  /** "Daemon started: <ISO>" -- set by daemon at boot. */
  daemonStarted?: string;
  /** "Last task started: <ISO>" -- daemon stamps when a task transitions to running. */
  lastTaskStarted?: string;
  /** "Last confirm request: <ISO>" -- daemon stamps on confirm() emit. */
  lastConfirmRequest?: string;
  /** "Last classifier block: <ISO>" -- daemon stamps when classifier blocks. */
  lastClassifierBlock?: string;
}

/** Result of a successful read. `null` is returned for missing/quarantined files. */
export interface StatusPointer {
  /**
   * The full sanitized + grapheme-cap-truncated file contents (header + body
   * combined). This is what gets wrapped in `<previous-context>` and prepended
   * to the system prompt. Per Data Guardian, body is opaque -- consumers
   * MUST NOT positionally re-parse it.
   */
  raw: string;
  /** Parsed values for the recognized header field labels. */
  headerFields: StatusPointerHeaderFields;
  /** True if the original file was longer than the grapheme cap. */
  truncated: boolean;
  /**
   * True if the file was deemed unparseable / not-text and was renamed
   * to `<path>.corrupt-<ts>.bak`. Always paired with a `null` return --
   * this flag exists for callers that want to surface the quarantine
   * via an `audit_pointer_corrupt` event.
   */
  quarantined: boolean;
}

export interface StatusPointerReaderOptions {
  /** Absolute path to status-pointer.md. */
  path: string;
  /**
   * Hard ceiling on graphemes (default 2000 per plan §"Status pointer
   * mechanism" Size cap row). Truncation past this point sets
   * `truncated: true` on the returned object.
   */
  maxGraphemes?: number;
}

const DEFAULT_MAX_GRAPHEMES = 2000;

/** NUL character (U+0000). Markdown never legitimately contains this. */
const NUL_CHAR = "\u0000";

/**
 * Per-label regex used to extract header fields from the parsed text.
 * Each pattern matches: start-of-line + label + ": " + capture-until-EOL.
 *
 * The regexes are anchored with `^` + `m` flag so they match per-line and
 * cannot cross blank-line boundaries (which separate header from body per
 * Data Guardian "header until first blank line"). We do not over-validate
 * the captured value here -- the daemon writes ISO timestamps but a hand-
 * edited file might have free text. Parsing is best-effort; the body
 * remains the source of truth for the model.
 */
const HEADER_PATTERNS: Record<keyof StatusPointerHeaderFields, RegExp> = {
  lastUpdated: /^Last updated: (.+)$/m,
  daemonStarted: /^Daemon started: (.+)$/m,
  lastTaskStarted: /^Last task started: (.+)$/m,
  lastConfirmRequest: /^Last confirm request: (.+)$/m,
  lastClassifierBlock: /^Last classifier block: (.+)$/m,
};

/**
 * Cached `Intl.Segmenter` -- constructing a Segmenter is non-trivial.
 * Reads happen once per daemon boot in the hot path, but the writer also
 * uses grapheme truncation on every body update, so caching is worthwhile.
 */
let cachedSegmenter: Intl.Segmenter | undefined;

function segmenter(): Intl.Segmenter {
  if (!cachedSegmenter) {
    cachedSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  }
  return cachedSegmenter;
}

/**
 * Truncate `text` to at most `maxGraphemes` graphemes.
 *
 * Returns `{ text, truncated }` where `truncated` is true if the input
 * exceeded the cap. The result is a prefix of the input on grapheme
 * boundaries -- emoji clusters, combining marks, ZWJ sequences, regional
 * indicators all stay intact.
 */
export function truncateByGraphemes(
  text: string,
  maxGraphemes: number,
): { text: string; truncated: boolean } {
  if (maxGraphemes <= 0) return { text: "", truncated: text.length > 0 };

  // Fast path: ASCII-ish text where char count == grapheme count is common
  // enough that we skip the iterator if the string is already under cap.
  // Conservative: a string whose `.length` (UTF-16 code units) is <=
  // maxGraphemes CAN have fewer graphemes (combining marks etc.), so
  // length<=cap is a sufficient short-circuit -- never wrong.
  if (text.length <= maxGraphemes) return { text, truncated: false };

  let count = 0;
  let endIndex = 0;
  for (const segment of segmenter().segment(text)) {
    if (count >= maxGraphemes) break;
    count += 1;
    endIndex = segment.index + segment.segment.length;
  }
  const sliced = text.slice(0, endIndex);
  return { text: sliced, truncated: sliced.length < text.length };
}

/**
 * Heuristic for "is this file binary garbage rather than markdown."
 *
 * Markdown files written by us never contain U+0000 (NUL). A NUL anywhere
 * in the file is a strong signal the file got corrupted (truncated write,
 * foreign tool wrote binary, filesystem damage). We quarantine these
 * rather than trying to render them in the system prompt.
 *
 * We deliberately do NOT use UTF-8 validity as the test -- `readFile(..., "utf8")`
 * already replaces invalid sequences with U+FFFD, so by the time we see the
 * string the bytes-level question is moot. NUL detection catches the
 * "wrote a binary blob over our markdown" failure mode.
 */
function looksLikeBinaryGarbage(text: string): boolean {
  return text.includes(NUL_CHAR);
}

export class StatusPointerReader {
  private readonly path: string;
  private readonly maxGraphemes: number;

  constructor(opts: StatusPointerReaderOptions) {
    this.path = opts.path;
    this.maxGraphemes = opts.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES;
  }

  /** Path of the underlying file (read-only accessor for tests/diagnostics). */
  get filePath(): string {
    return this.path;
  }

  /**
   * Read the status pointer. Returns `null` when the file is missing or
   * was quarantined. On success, returns a `StatusPointer` whose `raw`
   * field is safe to wrap in a `<previous-context>` envelope.
   */
  async read(): Promise<StatusPointer | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    if (looksLikeBinaryGarbage(raw)) {
      await this.quarantine();
      return null;
    }

    // Sanitize FIRST so prompt-injection markers are gone before any
    // substring search runs against the body. The header regexes don't
    // care about angle brackets (their labels are plain ASCII), so
    // sanitizing first does not destroy header parsing.
    const sanitized = sanitizeForPromptInjection(raw);

    const { text: capped, truncated } = truncateByGraphemes(
      sanitized,
      this.maxGraphemes,
    );

    const headerFields: StatusPointerHeaderFields = {};
    for (const [name, pattern] of Object.entries(HEADER_PATTERNS) as Array<
      [keyof StatusPointerHeaderFields, RegExp]
    >) {
      const m = pattern.exec(capped);
      if (m && m[1]) {
        headerFields[name] = m[1].trim();
      }
    }

    return {
      raw: capped,
      headerFields,
      truncated,
      quarantined: false,
    };
  }

  /**
   * Move the current file aside to `<path>.corrupt-<unix_ms>.bak`.
   * No-op if the file is missing. Public so the daemon boot sequence
   * can quarantine on its own initiative (e.g. after a schema change
   * that invalidates an old format).
   */
  async quarantine(): Promise<void> {
    const quarantinePath = `${this.path}.corrupt-${Date.now()}.bak`;
    try {
      await rename(this.path, quarantinePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
