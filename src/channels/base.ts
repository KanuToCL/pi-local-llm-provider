/**
 * Canonical channel-side types — Sink + InboundMessage + ChannelEvent +
 * InboundProcessor.
 *
 * IMPL-12 W3 owns this file.  It promotes the placeholder declarations that
 * were temporarily living in `src/tools/types.ts` (Sink, ChannelEvent) and
 * `src/lib/envelope.ts` (InboundMessage) so all channels and the daemon glue
 * import from one place.
 *
 * Why split the home this way:
 *   - `ToolUrgency` stays in `src/tools/types.ts` because it is genuinely
 *     a tool-side concept (the agent picks an urgency when calling tell()).
 *     `ChannelEvent` re-imports it here to keep the back-pointer.
 *   - `Sink` / `ChannelEvent` move here because the channel layer owns the
 *     transport semantics, not the tool layer.  `src/tools/types.ts`
 *     re-exports them so existing imports keep compiling.
 *   - `InboundMessage` moves here because every channel's inbound path needs
 *     the same shape; the envelope is just one consumer.
 *
 * Plan refs:
 *   - §"Sink interface design"
 *   - §"v4.3 Phase order revised" (Telegram = Phase 1, channel layer is the
 *     v1 critical path)
 *   - §"Lift wholesale" rows for `requireAllowedUser` (auth.ts) and
 *     `chunkOutbound`
 *   - §"v4 changelog Accessibility" — voice/image arrival policy
 */

import type { ToolUrgency } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Channel identity
// ---------------------------------------------------------------------------

/**
 * Closed enum of channel ids.
 *
 * Adding a new channel: extend this union, update the audit-event channel
 * enum in `src/audit/schema.ts`, add the per-channel sink wiring in the
 * daemon glue.
 */
export type ChannelId = "terminal" | "whatsapp" | "telegram";

// ---------------------------------------------------------------------------
// InboundMessage — what arrives FROM a channel
// ---------------------------------------------------------------------------

/**
 * One inbound user-originated message, normalized across channels.
 *
 * For non-text inbound, the appropriate `payload.*Ref` field holds an
 * absolute filesystem path written by `InboundMediaStore`
 * (`src/lib/inbound-media.ts`) — typically under
 * `~/.pi-comms/inbound-media/<msgId>.<ext>` per plan §"v4 changelog
 * Accessibility — audioRef seam":
 *   - voice notes / audio attachments       → `payload.audioRef`
 *   - photos / image attachments            → `payload.imageRef`
 *   - documents (PDF / docx / etc.)         → `payload.documentRef`
 *   - videos / stickers / animated content  → `payload.videoRef`
 *
 * v1 does NOT decode those — the channel synthesizes a textual placeholder
 * via Pitfall #21 voice-arrival policy so the agent surface stays uniform
 * (`payload.text` always carries something the model can read).  The
 * media-ref fields ARE populated by the channel layer (Telegram + WhatsApp
 * download the buffer, hand it to InboundMediaStore.save*, and store the
 * returned path here) so v2 (whisper.cpp / vision) can pick the file up
 * without re-plumbing the inbound path.
 *
 * The `type` field still uses the v1 closed enum (text / voice / image)
 * for back-compat with envelope.ts; documents and videos collapse to
 * `image` in `type` but get a dedicated ref field so v2 routing can
 * disambiguate without losing fidelity.
 */
export interface InboundMessage {
  type: "text" | "voice" | "image";
  channel: ChannelId;
  sender: { id: string; name?: string };
  payload: {
    text?: string;
    audioRef?: string;
    imageRef?: string;
    documentRef?: string;
    videoRef?: string;
  };
  ts: number;
}

// ---------------------------------------------------------------------------
// ChannelEvent — what gets sent OUT to a channel
// ---------------------------------------------------------------------------

/**
 * A side-channel event a tool / framework wants emitted to a channel sink.
 *
 * Tools NEVER write directly to a channel; they hand a `ChannelEvent` to a
 * `Sink` and the sink owns transport.  This keeps the destructive-command
 * sandbox + redaction logic in one place (the channel layer) instead of
 * every tool needing to know about per-channel formatting.
 *
 * Lifted (and EXTENDED) from the placeholder previously in
 * `src/tools/types.ts`.  New event types added in W3:
 *   - `reply`           — normal sync reply text from the agent (terminal
 *                         echo + telegram bot send).  Channel emits this
 *                         WITHOUT a prefix because that IS the conversation.
 *   - `task_completed`  — framework auto-completion final message.  Plan
 *                         §"v4.3 simplified tell() role" — framework owns
 *                         the final reply, tell() only mid-task interrupts.
 *   - `system_notice`   — daemon-internal infrastructure notice (boot,
 *                         shutdown, studio health).  Severity-prefixed.
 */
export type ChannelEvent =
  | {
      type: "tell";
      urgency: ToolUrgency;
      text: string;
      ts: number;
    }
  | {
      type: "confirm_request";
      shortId: string;
      question: string;
      rationale: string;
      risk: string;
      expiresAt: number;
      ts: number;
    }
  | {
      type: "auto_promote_notice";
      firingNumber: number;
      taskAgeSeconds: number;
      ts: number;
    }
  | {
      type: "go_background_notice";
      userMessagePreview: string;
      ts: number;
    }
  | {
      type: "reply";
      text: string;
      ts: number;
    }
  | {
      type: "task_completed";
      taskId: string;
      finalMessage: string;
      ts: number;
    }
  | {
      type: "system_notice";
      text: string;
      level: "info" | "warn" | "error";
      ts: number;
    };

// ---------------------------------------------------------------------------
// Sink — the canonical interface
// ---------------------------------------------------------------------------

/**
 * One sink per attached client.
 *
 * Send semantics:
 *   - Each call MUST be best-effort.  If the underlying transport is dead
 *     (WhatsApp re-pair needed, terminal client disconnected, etc.) the
 *     sink should resolve (not reject) and the failure is observable via
 *     channel state, NOT via this method's return value.  Tools fan out to
 *     multiple sinks in parallel via `fanOut()` (in `src/tools/types.ts`)
 *     and a single sink failing must not block the others.
 *   - Sinks SHOULD be idempotent w.r.t. duplicate event ids when they have
 *     them; tools do not pre-dedup at the sink layer.
 */
export interface Sink {
  send(event: ChannelEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// InboundProcessor — what a channel calls when a user message arrives
// ---------------------------------------------------------------------------

/**
 * The daemon implements this interface and hands it to every channel.
 * Channels call `processInbound()` when they get a message from a
 * verified-allowlisted private DM.
 *
 * Fire-and-forget: the channel must NOT await this promise inside its
 * message handler — that would block the long-poll loop.  The daemon
 * picks up the message, queues it on the single in-flight task slot
 * (per plan §"Phase 1.5 — Single In-Flight Task"), and the channel
 * immediately returns to polling.
 */
export interface InboundProcessor {
  processInbound(msg: InboundMessage): Promise<void>;
}

// ---------------------------------------------------------------------------
// Re-export ToolUrgency for callers that only want to import from
// channels/base — saves them a hop into tools/types.
// ---------------------------------------------------------------------------

export type { ToolUrgency } from "../tools/types.js";
