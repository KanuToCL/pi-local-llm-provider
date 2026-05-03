/**
 * Status-pointer writer -- daemon-mediated atomic writes to
 * `~/.pi-comms/status-pointer.md`.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - Pitfall #30 (line 1270): all pointer writes go through daemon-mediated
 *     IPC verb `pointer-write`; daemon serializes via JsonSessionStore-style
 *     writeQueue (atomic temp+rename). The agent's `write` tool MUST NOT
 *     hit this file directly -- doing so would race with daemon header
 *     updates (Daemon stamps `Last task started` at the same time the agent
 *     stamps `## Currently working on`, last-writer-wins, header lost).
 *   - Pitfall #23 (line 1263): bodies passed in via `writeBody` are
 *     attacker-influenceable (the agent ultimately came from a remote
 *     channel). Sanitize prompt-section markers before commit.
 *   - Data Guardian "atomic write" (line 1319): tempfile + rename.
 *   - Data Guardian "2000-char grapheme cap" (line 1320): grapheme-aware
 *     truncation, not byte cap.
 *   - Observability "pointer-history.jsonl" (line 1347): on every daemon
 *     boot, append the prior body to `pointer-history.jsonl` BEFORE
 *     overwriting status-pointer.md. Without this, a daemon that boots
 *     and immediately updates the header destroys the prior agent's
 *     final notes -- forensic blind spot.
 *
 * File layout invariants this writer enforces:
 *   - Header section: lines matching `^Label: value$` for any of the five
 *     known header labels. Header may include the leading `# pi-comms
 *     status pointer` h1 and arbitrary blank lines between fields.
 *   - First non-header section break is the first blank line after the
 *     last header field. Everything after that is the BODY.
 *   - `updateHeader` only touches the header section; body is preserved
 *     character-for-character.
 *   - `writeBody` only touches the body; header is preserved.
 *   - On a fresh write where no file exists, both calls scaffold the
 *     missing section with a default skeleton.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sanitizeForPromptInjection } from "../lib/sanitize.js";
import { truncateByGraphemes } from "./reader.js";

/**
 * Subset of header fields the daemon stamps. Every field is optional
 * because callers update a subset at a time (e.g. `daemonStarted` is
 * only stamped at boot; `lastTaskStarted` only on task-running
 * transitions).
 */
export interface StatusPointerHeaderUpdate {
  /** "Last updated: <ISO>" -- bumped on every write. Defaulted by writer if absent. */
  lastUpdated?: string;
  /** "Daemon started: <ISO>" -- stamped at daemon boot. */
  daemonStarted?: string;
  /** "Last task started: <ISO>" -- stamped on task -> running transition. */
  lastTaskStarted?: string;
  /** "Last confirm request: <ISO>" -- stamped on confirm() emit. */
  lastConfirmRequest?: string;
  /** "Last classifier block: <ISO>" -- stamped on classifier block emit. */
  lastClassifierBlock?: string;
}

/** Result of a `writeBody` call. */
export interface WriteBodyResult {
  /** True when the write committed (always true unless an error throws). */
  written: boolean;
  /** True when the body was longer than the grapheme cap and got truncated. */
  truncated: boolean;
}

export interface StatusPointerWriterOptions {
  /** Absolute path to status-pointer.md. */
  path: string;
  /**
   * Optional override for the grapheme cap. Defaults to 2000 per plan
   * §"Status pointer mechanism" Size cap row. Tests use smaller values
   * to exercise the truncation path quickly.
   */
  maxGraphemes?: number;
  /**
   * Optional path for the boot-time history log. Defaults to a sibling
   * `pointer-history.jsonl` next to the status pointer file. Each
   * `archivePriorOnBoot` call appends one JSONL line.
   */
  historyPath?: string;
  /**
   * Override for the daemon PID stamped into history entries. Tests use
   * a deterministic value; production passes `process.pid`.
   */
  daemonPid?: number;
}

const DEFAULT_MAX_GRAPHEMES = 2000;

/**
 * Set of recognized header field labels in the order they appear in the
 * default skeleton. Mapping order matters for the rendered output --
 * we always serialize in this order regardless of the order the caller
 * supplied keys, so the file format stays stable across writes.
 */
const HEADER_LABELS: Array<[keyof StatusPointerHeaderUpdate, string]> = [
  ["lastUpdated", "Last updated"],
  ["daemonStarted", "Daemon started"],
  ["lastTaskStarted", "Last task started"],
  ["lastConfirmRequest", "Last confirm request"],
  ["lastClassifierBlock", "Last classifier block"],
];

/** Top-level h1 line that opens the file. */
const TITLE_LINE = "# pi-comms status pointer";

/** Body skeleton used when no body has ever been written. */
const DEFAULT_BODY = `## Currently working on
(no current task)

## Last completed
(none)

## Pending / blocked
(none)

## Open confirms (waiting on user)
(none)
`;

interface PointerHistoryEntry {
  /** ISO-8601 of the boot at which the prior body was archived. */
  boot_ts: string;
  /** Verbatim prior body, after sanitization, before truncation. */
  prior_body: string;
  /** SHA-256 of prior_body for dedup / forensic chain-of-custody. */
  prior_sha256: string;
  /** PID of the daemon that performed the archive. */
  daemon_pid: number;
}

/**
 * Split the existing file content into (headerLines, bodyLines).
 *
 * Header is everything before the FIRST `^##` markdown subheader OR
 * the first blank line that follows at least one recognized header
 * field, whichever comes first. We use both signals because hand-edited
 * files might omit the blank line, and a fresh skeleton has the body
 * starting with `## Currently working on`.
 */
function splitHeaderAndBody(text: string): { header: string[]; body: string } {
  const lines = text.split("\n");
  let splitIndex = lines.length;
  let sawHeaderField = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // The body starts at the first H2 (`## …`) heading.
    if (line.startsWith("## ")) {
      splitIndex = i;
      break;
    }
    // Or at the first blank line after we've seen at least one header field.
    if (sawHeaderField && line.trim() === "") {
      splitIndex = i;
      break;
    }
    if (isHeaderFieldLine(line)) {
      sawHeaderField = true;
    }
  }

  const header = lines.slice(0, splitIndex);
  const bodyLines = lines.slice(splitIndex);
  // Strip a single leading blank from the body if present -- it was the
  // separator between header and body.
  while (bodyLines.length > 0 && bodyLines[0].trim() === "") {
    bodyLines.shift();
  }
  return { header, body: bodyLines.join("\n") };
}

function isHeaderFieldLine(line: string): boolean {
  for (const [, label] of HEADER_LABELS) {
    if (line.startsWith(`${label}: `)) return true;
  }
  return false;
}

/**
 * Parse a header-section line array into a partial map. Unknown
 * lines (the title, blank lines, comments) are discarded -- they
 * are re-synthesized from `TITLE_LINE` on render.
 */
function parseHeaderFields(lines: string[]): StatusPointerHeaderUpdate {
  const out: StatusPointerHeaderUpdate = {};
  for (const line of lines) {
    for (const [key, label] of HEADER_LABELS) {
      const prefix = `${label}: `;
      if (line.startsWith(prefix)) {
        out[key] = line.slice(prefix.length).trim();
        break;
      }
    }
  }
  return out;
}

/**
 * Render header fields back to a fixed-format header block:
 *   # pi-comms status pointer
 *   Last updated: <iso>
 *   Daemon started: <iso>
 *   ...
 *
 * Fields whose values are missing are simply omitted (no `Label: ` line).
 * The trailing blank line that separates header from body is added by
 * the caller, not here.
 */
function renderHeader(fields: StatusPointerHeaderUpdate): string {
  const lines: string[] = [TITLE_LINE];
  for (const [key, label] of HEADER_LABELS) {
    const value = fields[key];
    if (value !== undefined && value !== "") {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines.join("\n");
}

export class StatusPointerWriter {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly maxGraphemes: number;
  private readonly historyPath: string;
  private readonly daemonPid: number;

  constructor(opts: StatusPointerWriterOptions) {
    this.path = opts.path;
    this.maxGraphemes = opts.maxGraphemes ?? DEFAULT_MAX_GRAPHEMES;
    this.historyPath = opts.historyPath ?? `${dirname(opts.path)}/pointer-history.jsonl`;
    this.daemonPid = opts.daemonPid ?? process.pid;
  }

  /** Path of the underlying status pointer file. */
  get filePath(): string {
    return this.path;
  }

  /** Path of the JSONL history log. */
  get historyFilePath(): string {
    return this.historyPath;
  }

  /**
   * Update header fields in-place. The body is preserved verbatim. If
   * the file does not yet exist, a fresh skeleton is materialized with
   * the supplied header fields plus the `DEFAULT_BODY`.
   *
   * Mutually serialized with `writeBody` and `archivePriorOnBoot` via
   * the per-instance writeQueue (per Pitfall #30).
   */
  async updateHeader(opts: StatusPointerHeaderUpdate): Promise<void> {
    return this.enqueueWrite(async () => {
      const existing = await this.tryReadExisting();
      const { header: headerLines, body: existingBody } = existing
        ? splitHeaderAndBody(existing)
        : { header: [], body: "" };

      const merged: StatusPointerHeaderUpdate = {
        ...parseHeaderFields(headerLines),
        ...opts,
      };

      const body = existingBody.length > 0 ? existingBody : DEFAULT_BODY;
      await this.commitAtomic(this.composeFile(merged, body));
    });
  }

  /**
   * Replace the body section of the status pointer. Header fields are
   * preserved. The body is sanitized for prompt-injection markers and
   * grapheme-cap-truncated before commit.
   *
   * Mutually serialized with `updateHeader` and `archivePriorOnBoot`.
   *
   * Returns `{ written, truncated }`. `written` is always true on
   * resolution; the field exists so callers can in future surface a
   * `false` for short-circuit cases (e.g. body identical to existing,
   * see V5 backlog).
   */
  async writeBody(body: string): Promise<WriteBodyResult> {
    let truncated = false;
    await this.enqueueWrite(async () => {
      const sanitized = sanitizeForPromptInjection(body);
      const capped = truncateByGraphemes(sanitized, this.maxGraphemes);
      truncated = capped.truncated;

      const existing = await this.tryReadExisting();
      const { header: headerLines } = existing
        ? splitHeaderAndBody(existing)
        : { header: [] };
      const headerFields = parseHeaderFields(headerLines);

      await this.commitAtomic(this.composeFile(headerFields, capped.text));
    });
    return { written: true, truncated };
  }

  /**
   * Append the current pointer body (if any) to `pointer-history.jsonl`
   * as a single JSON line, then leave the status-pointer.md file in
   * place. Intended to be called once at daemon boot, BEFORE
   * `updateHeader({ daemonStarted })` rewrites the file -- see
   * Observability "pointer-history.jsonl" (line 1347).
   *
   * If no prior pointer file exists, this is a no-op (the daemon has
   * never run on this host before, or the file was wiped).
   *
   * Note: this method does NOT mutate or delete the status-pointer.md
   * file. Subsequent `updateHeader` calls will overwrite it; the
   * history line we just appended preserves the prior body for
   * forensic recovery.
   */
  async archivePriorOnBoot(): Promise<void> {
    return this.enqueueWrite(async () => {
      const existing = await this.tryReadExisting();
      if (existing === null) return;

      // Sanitize before archiving so prompt-injection markers also can't
      // contaminate the JSONL log when an operator greps it. Truncate
      // is intentionally NOT applied to history -- we want forensic
      // fidelity even at the cost of larger lines.
      const { body } = splitHeaderAndBody(existing);
      const sanitized = sanitizeForPromptInjection(body);

      const entry: PointerHistoryEntry = {
        boot_ts: new Date().toISOString(),
        prior_body: sanitized,
        prior_sha256: createHash("sha256").update(sanitized).digest("hex"),
        daemon_pid: this.daemonPid,
      };

      const line = `${JSON.stringify(entry)}\n`;
      await mkdir(dirname(this.historyPath), { recursive: true });
      await appendFile(this.historyPath, line, "utf8");
    });
  }

  /**
   * Compose header fields + body into the on-disk file format. Always
   * separates header and body with one blank line so subsequent reads
   * find the boundary unambiguously.
   */
  private composeFile(header: StatusPointerHeaderUpdate, body: string): string {
    const headerText = renderHeader(header);
    const trimmedBody = body.replace(/\n+$/, "");
    return `${headerText}\n\n${trimmedBody}\n`;
  }

  private async tryReadExisting(): Promise<string | null> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Atomic temp+rename write -- mirrors the gemini-claw JsonSessionStore
   * pattern that JsonStore lifts (see src/storage/json-store.ts).
   * Caller is responsible for serializing via `enqueueWrite`.
   */
  private async commitAtomic(content: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, this.path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Serialize an async operation behind any in-flight write. Mirrors
   * `JsonStore.enqueueWrite` (see src/storage/json-store.ts:122).
   * Errors do not poison the queue.
   */
  private enqueueWrite<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.writeQueue.then(operation, operation);
    // Discard return value for the queue chain; the call-site keeps R.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
