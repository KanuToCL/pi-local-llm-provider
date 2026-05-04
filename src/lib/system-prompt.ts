/**
 * Compose the daemon's system prompt at boot time.
 *
 * Inputs:
 *   - basePromptPath: SHA-pinned base prompt (default
 *     `prompts/coding-agent.v2.txt`; v1 was deleted in pi-comms v0.2.1
 *     per Ring-of-Elders Triangle convergence — see
 *     `tests/system-prompt.test.ts` SHA-pin discipline).
 *   - pointerPath: optional status-pointer file. Read best-effort: if it
 *     does not exist, is unreadable, or contains nothing useful, the
 *     pointer block is silently omitted (per plan §"Pitfall #9 corrupt-
 *     pointer resilience" — daemon must boot even with a bad pointer).
 *   - pointerSizeCap: maximum number of grapheme codepoints kept from the
 *     pointer body. Truncated at a grapheme boundary using `Intl.Segmenter`
 *     so we never split a multi-codepoint emoji or combining sequence.
 *
 * Output: final composed prompt — base, then (if pointer survived)
 * a `<previous-context>…</previous-context>` envelope holding the
 * sanitized pointer body. The envelope's contents are sanitized via
 * `sanitizeForPromptInjection` so a malicious or accidentally-wild
 * pointer body cannot escape and forge `<system>` / prompt-section
 * markers (per plan Pitfall #23).
 */

import { readFileSync } from "node:fs";
import { sanitizeForPromptInjection } from "./sanitize.js";

export interface ComposeSystemPromptOptions {
  basePromptPath: string;
  pointerPath?: string;
  /** Max number of grapheme clusters retained from pointer body. */
  pointerSizeCap: number;
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

export function composeSystemPrompt(opts: ComposeSystemPromptOptions): string {
  const base = readFileSync(opts.basePromptPath, "utf8").trimEnd();

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
