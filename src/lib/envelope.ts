/**
 * Cross-channel context envelope.
 *
 * Wraps an inbound message in a `<user-input …>…</user-input>` block before
 * it is appended to the model's input. The envelope:
 *   - Names the channel (terminal | whatsapp | telegram) so the agent can
 *     adapt format/verbosity (terminal=verbose, whatsapp=concise).
 *   - Includes a stable hash of the sender id (NOT the raw id — privacy).
 *   - Includes the daemon cwd at composition time (useful when the agent
 *     reasons about file paths it received over a remote channel).
 *   - Includes a wall-clock timestamp.
 *
 * The body is sanitized via `sanitizeForPromptInjection` so a malicious
 * sender cannot escape the envelope and forge `<system>` / prompt-section
 * markers. Per plan §"Lift wholesale" + Pitfalls #6, #23, RS-3.
 */

import { createHash } from "node:crypto";
import { sanitizeForPromptInjection } from "./sanitize.js";

// ---------------------------------------------------------------------------
// TODO(IMPL-12, W3): the canonical home for `InboundMessage` is
// `src/channels/base.ts`. IMPL-12 will define it there and re-export from
// this module's import path. For now we define it locally so this file
// type-checks before W3 lands. After W3 the local definition should be
// deleted and this file should switch to:
//
//   import type { InboundMessage } from '../channels/base.js';
// ---------------------------------------------------------------------------

export interface InboundMessage {
  type: "text" | "voice" | "image";
  channel: "terminal" | "whatsapp" | "telegram";
  sender: { id: string; name?: string };
  payload: { text?: string; audioRef?: string; imageRef?: string };
  ts: number;
}

/** Stable, non-reversible 12-hex-char hash of a sender id. */
function hashSenderId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/** Escape XML attribute-value characters defensively. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Compose the envelope. The body is taken from `payload.text` for text
 * messages; for voice/image the body becomes a placeholder pointing to the
 * external ref so the agent knows there is non-text content waiting.
 */
export function composeContextEnvelope(msg: InboundMessage): string {
  const senderHash = hashSenderId(msg.sender.id);
  const cwd = process.cwd();
  const ts = new Date(msg.ts).toISOString();

  let bodyRaw = "";
  if (msg.type === "text") {
    bodyRaw = msg.payload.text ?? "";
  } else if (msg.type === "voice") {
    bodyRaw = `[voice message; audioRef=${msg.payload.audioRef ?? "unknown"}]`;
  } else if (msg.type === "image") {
    bodyRaw = `[image; imageRef=${msg.payload.imageRef ?? "unknown"}]`;
  }

  const bodySanitized = sanitizeForPromptInjection(bodyRaw);

  const attrs = [
    `channel="${escapeAttr(msg.channel)}"`,
    `sender_id_hash="${escapeAttr(senderHash)}"`,
    `cwd="${escapeAttr(cwd)}"`,
    `ts="${escapeAttr(ts)}"`,
  ].join(" ");

  return `<user-input ${attrs}>\n${bodySanitized}\n</user-input>`;
}
