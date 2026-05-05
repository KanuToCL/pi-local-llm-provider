/**
 * Compose the daemon's system prompt at boot time.
 *
 * Inputs:
 *   - basePromptPath: SHA-pinned base prompt (default
 *     `prompts/coding-agent.v3.txt`; v2 is preserved as the config-rollback
 *     fallback fixture per Ring-of-Elders v0.3 PE I5; v1 was deleted in
 *     pi-comms v0.2.1 — see `tests/system-prompt.test.ts` SHA-pin
 *     discipline).
 *   - pointerPath: optional status-pointer file. Read best-effort: if it
 *     does not exist, is unreadable, or contains nothing useful, the
 *     pointer block is silently omitted (per plan §"Pitfall #9 corrupt-
 *     pointer resilience" — daemon must boot even with a bad pointer).
 *   - pointerSizeCap: maximum number of grapheme codepoints kept from the
 *     pointer body. Truncated at a grapheme boundary using `Intl.Segmenter`
 *     so we never split a multi-codepoint emoji or combining sequence.
 *   - hostOs: REQUIRED. Identifier for the host operating system (callers
 *     pass `process.platform`). Used to substitute the `${HOST_ENV_SECTION}`
 *     placeholder in v3+ prompts with OS-specific shell guidance (UX U3 —
 *     prevents the model from emitting POSIX-only commands on Windows).
 *     Validated against an explicit allow-list (Security W1 — defends
 *     against prompt injection via process.platform tampering or stale
 *     `--platform` overrides). Unknown values throw before any substitution.
 *
 * Output: final composed prompt — base (with `${HOST_ENV_SECTION}`
 * substituted), then (if pointer survived) a
 * `<previous-context>…</previous-context>` envelope holding the
 * sanitized pointer body. The envelope's contents are sanitized via
 * `sanitizeForPromptInjection` so a malicious or accidentally-wild
 * pointer body cannot escape and forge `<system>` / prompt-section
 * markers (per plan Pitfall #23).
 */

import { readFileSync } from "node:fs";
import { sanitizeForPromptInjection } from "./sanitize.js";

/**
 * Allow-list of recognized host-OS identifiers (NodeJS.Platform values).
 *
 * Intentional conservative allow-list rather than `typeof process.platform`:
 *   - Catches typos like `"macos"` (the colloquial name for `"darwin"`).
 *   - Rejects empty strings, multi-line injection payloads, or anything else
 *     a tampered-with environment might produce.
 *   - Adding a new platform requires touching this constant — the change
 *     surface stays grep-able.
 *
 * Source: NodeJS.Platform union per @types/node — kept in sync intentionally.
 */
const ALLOWED_HOST_OS: ReadonlySet<string> = new Set([
  "darwin",
  "linux",
  "win32",
  "freebsd",
  "openbsd",
  "aix",
  "sunos",
  "android",
]);

export interface ComposeSystemPromptOptions {
  basePromptPath: string;
  pointerPath?: string;
  /** Max number of grapheme clusters retained from pointer body. */
  pointerSizeCap: number;
  /**
   * Host operating system identifier. Callers pass `process.platform`.
   * Validated against `ALLOWED_HOST_OS`; unknown values throw.
   * REQUIRED in v0.3+ — the prompt template's `${HOST_ENV_SECTION}`
   * placeholder requires a known OS to render.
   */
  hostOs: string;
}

/** Read a file or return undefined on any failure. Never throws. */
function readSafe(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Truncate `text` to at most `cap` grapheme clusters.
 *
 * Uses `Intl.Segmenter` (Node ≥16) so we cut at a real grapheme boundary
 * rather than mid-codepoint or mid-combining-sequence. Cheap O(n) walk —
 * we stop iterating as soon as we hit the cap.
 */
function graphemeTruncate(text: string, cap: number): string {
  if (cap <= 0 || !text) return "";
  // Fast path: ASCII-only strings have grapheme count == length, so we
  // can skip Segmenter when the byte length is already within budget.
  if (text.length <= cap) return text;

  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  let cutAt = text.length;
  for (const seg of segmenter.segment(text)) {
    if (count >= cap) {
      cutAt = seg.index;
      break;
    }
    count += 1;
  }
  return text.slice(0, cutAt);
}

/**
 * Render the OS-conditional Host environment section body.
 *
 * Three branches per plan §1.3b:
 *   - `win32` → cmd.exe caveat block (POSIX flags will fail; concrete swaps).
 *   - `darwin` | `linux` → 1-line standard POSIX confirmation.
 *   - any other recognized POSIX-ish (`freebsd`, `openbsd`, `aix`, `sunos`,
 *     `android`) → conservative POSIX assumptions paragraph.
 *
 * Caller MUST validate `hostOs` against `ALLOWED_HOST_OS` first; this
 * function trusts its input. Unknown OS would silently fall through to the
 * POSIX fallback which is wrong — guarded by the allow-list.
 */
function renderHostEnvSection(hostOs: string): string {
  if (hostOs === "win32") {
    return `You are running on \`win32\`. The bash tool routes through \`cmd.exe /d /s /c <cmd>\`. POSIX-only flags WILL FAIL or do unexpected things. Specifically:
- \`mkdir -p X\` → use plain \`mkdir X\` (cmd.exe creates parent dirs automatically and silently no-ops if X exists).
- \`cat F\` → use \`type F\`.
- \`rm -rf X\` → use \`rmdir /s /q X\` for directories, \`del /f /q X\` for files.
- Path separators: prefer backslash or quote forward-slash paths.`;
  }
  if (hostOs === "darwin" || hostOs === "linux") {
    return `You are running on \`${hostOs}\`. The bash tool uses standard POSIX shell (\`sh\`); \`mkdir -p\`, \`cat\`, \`grep\`, forward slashes work as usual.`;
  }
  // Other recognized POSIX-ish: emit conservative POSIX assumptions.
  return `You are running on \`${hostOs}\`. The bash tool uses a POSIX-style shell. Standard POSIX commands (\`mkdir -p\`, \`cat\`, \`grep\`) typically work.`;
}

export function composeSystemPrompt(opts: ComposeSystemPromptOptions): string {
  // Defense-in-depth #1: validate hostOs BEFORE any I/O or substitution.
  // Unknown values (typos, empty strings, injection payloads with newlines)
  // throw eagerly so the daemon's boot-time loader fails loud instead of
  // silently emitting a degraded prompt with a literal placeholder.
  if (!ALLOWED_HOST_OS.has(opts.hostOs)) {
    throw new Error(
      `composeSystemPrompt: invalid hostOs ${JSON.stringify(opts.hostOs)} — must be one of ${[
        ...ALLOWED_HOST_OS,
      ].join(", ")}`,
    );
  }

  const baseRaw = readFileSync(opts.basePromptPath, "utf8").trimEnd();
  const hostEnv = renderHostEnvSection(opts.hostOs);
  const base = baseRaw.replace(/\$\{HOST_ENV_SECTION\}/g, hostEnv);

  // Defense-in-depth #2: post-substitution scan. If the prompt file ever
  // ships with an unrecognized placeholder (typo like `${HOST_OS}`, or a
  // future placeholder not wired up in this loader), throw so the daemon
  // fails LOUD instead of leaking a literal `${...}` token to pi-mono
  // (UX U2 — silent placeholder-substitution failure regression guard).
  if (base.includes("${HOST_ENV_SECTION}") || base.includes("${HOST_OS}")) {
    throw new Error(
      "composeSystemPrompt: placeholder substitution failed — base prompt still contains a literal ${HOST_ENV_SECTION} or ${HOST_OS} after substitution",
    );
  }

  const rawPointer = readSafe(opts.pointerPath);
  if (rawPointer === undefined) {
    return base;
  }

  const trimmed = rawPointer.trim();
  if (!trimmed) {
    return base;
  }

  const truncated = graphemeTruncate(trimmed, opts.pointerSizeCap);
  const sanitized = sanitizeForPromptInjection(truncated).trim();
  if (!sanitized) {
    return base;
  }

  return `${base}\n\n<previous-context>\n${sanitized}\n</previous-context>`;
}
