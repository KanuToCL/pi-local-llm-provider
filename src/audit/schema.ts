/**
 * Audit log entry schema (zod-typed).
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"v4 changelog from Round-1 elder findings" Observability rows
 *     (lines 1346-1355): typed AuditEntry, vocabulary expansion,
 *     daemon_shutdown bracketing, sender_id hashing.
 *   - §"v4.2" — `unsand_enabled` audit field expansion (line 1526)
 *     and sandbox boot events (line 1488).
 *   - Pitfall #28 (line 1268): every audit line must round-trip safely
 *     through `JSON.stringify`, so this schema keeps `extra` to scalars
 *     only — no nested objects, no arrays — to keep the encoded line
 *     compact and trivially auditable.
 *
 * Field semantics:
 *   - `ts`: ISO-8601 UTC timestamp produced at append time.
 *   - `daemon_uptime_s`: integer seconds since the daemon started.
 *     Useful for correlating events across a single boot without
 *     parsing wall-clock timestamps.
 *   - `task_id`: the running task's id, or `null` for events that are
 *     not in the context of a task (boot, shutdown, daemon-wide health).
 *   - `channel`: the originating channel of the event. Use 'system' for
 *     daemon-internal events that did not originate from a user message.
 *   - `sender_id_hash`: SHA-256 of (raw sender id || install_salt). The
 *     install_salt lives in `~/.pi-comms/install.json` and is created
 *     once per install. The raw sender jid/user-id MUST NEVER be logged
 *     — only the salted hash. `null` for system-originated events.
 *   - `inbound_msg_hash` / `outbound_msg_hash`: SHA-256 of the message
 *     text, used for dedup correlation across events without keeping
 *     the cleartext.
 *   - `extra`: optional bag of scalar fields for event-specific context
 *     (e.g. `{ scope: 'next-task', expires_at: '2026-04-28T15:00:00Z' }`).
 *     Restricted to scalars (string/number/boolean) to keep the JSONL
 *     line both readable and immune to nested-injection mischief.
 *
 * Adding a new event kind:
 *   1. Add it to `AuditEventType` below.
 *   2. Update tests/audit-log.test.ts with at least one positive case
 *      that exercises the new kind.
 *   3. If the event needs new typed fields, prefer adding them to
 *      `extra` first; promote to a top-level field only if they are
 *      common across many events (e.g. `duration_ms`).
 */

import { z } from "zod";

/**
 * Enumerated event kinds. Categories (kept in source order):
 *   - daemon lifecycle: boot, shutdown, pointer load
 *   - task lifecycle: started, completed, failed, cancelled, abandoned
 *   - background / scheduling: auto_promote, go_background, serial_queue
 *   - messaging primitives: tell, confirm (request/resolved/timed_out/rejected)
 *   - guards: classifier, allowlist, dm-only
 *   - channels: whatsapp / telegram connect/disconnect/reauth
 *   - studio health: ok / fail / recovered
 *   - daemon liveness: pi_heartbeat, pi_stuck_suspected
 *   - session bookkeeping: recreate, autocompaction
 *   - sandbox / un-sand: enabled, disabled, force-engaged-on-boot
 *   - prompt versioning: prompt_version_changed
 */
export const AuditEventType = z.enum([
  // Daemon lifecycle
  "daemon_boot",
  "daemon_shutdown",
  "pointer_loaded",
  "pointer_corrupt",
  // Task lifecycle
  "task_started",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "task_abandoned_on_restart",
  // Background / scheduling
  "auto_promote_fired",
  "go_background_called",
  "serial_queue_blocked",
  // Messaging primitives
  "tell_emit",
  "confirm_request",
  "confirm_resolved",
  "confirm_timed_out",
  "confirm_rejected",
  // Guards
  "classifier_block",
  "classifier_confirm_required",
  "allowlist_reject",
  "dm_only_reject",
  // Channels
  "whatsapp_connect",
  "whatsapp_disconnect",
  "whatsapp_reauth_needed",
  "telegram_connect",
  "telegram_disconnect",
  // Studio health
  "studio_health_ok",
  "studio_health_fail",
  "studio_recovered",
  // Daemon liveness
  "pi_heartbeat",
  "pi_stuck_suspected",
  // Session bookkeeping
  "session_recreate",
  "autocompaction_detected",
  // Sandbox / un-sand
  "unsand_enabled",
  "unsand_disabled",
  "sandbox_force_engaged_on_boot",
  // Prompt versioning
  "prompt_version_changed",
]);

export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEntrySchema = z.object({
  /** ISO-8601 UTC timestamp produced at append time. */
  ts: z.string(),
  /** Integer seconds since daemon boot. */
  daemon_uptime_s: z.number().int().nonnegative(),
  /** Event kind — see `AuditEventType` for the closed enumeration. */
  event: AuditEventType,
  /** Task this event belongs to, or `null` for daemon-wide events. */
  task_id: z.string().nullable(),
  /** Originating channel; 'system' for daemon-internal events. */
  channel: z.enum(["terminal", "whatsapp", "telegram", "system"]),
  /** SHA-256(sender_id || install_salt); `null` for system events. */
  sender_id_hash: z.string().nullable(),
  /** SHA-256 of the inbound message text, when applicable. */
  inbound_msg_hash: z.string().optional(),
  /** SHA-256 of the outbound message text, when applicable. */
  outbound_msg_hash: z.string().optional(),
  /** Tool name (e.g. 'tell', 'confirm', 'bash'), when applicable. */
  tool_call_name: z.string().optional(),
  /** Wall-clock duration in milliseconds for events that span time. */
  duration_ms: z.number().optional(),
  /** Error class/name when the event represents a failure. */
  error_class: z.string().optional(),
  /** Event-specific scalar context. No nested objects/arrays. */
  extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
