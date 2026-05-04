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
  // Per-sender / per-channel ingress rate limiting (FIX-B-3 Wave 8). Fires
  // BEFORE the allowlist/DM-only checks; silent reject (no reply). `extra`
  // carries `reason: 'per_sender' | 'per_channel'`.
  "inbound_rate_limited",
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
  "studio_model_swap_detected",
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
  // Lock / panic gate (RS-2)
  "lock_engaged_reject",
  // IPC lifecycle (separate from daemon-wide events)
  "ipc_attach",
  "ipc_detach",
  // Tool execution latency instrumentation (FIX-B-2 #2)
  // Per plan §"v4 Observability latency instrumentation":
  //   bash tool emits start+end with cmd_hash + duration_ms so post-incident
  //   review can correlate sandbox/classifier decisions with actual cost.
  "tool_execution_start",
  "tool_execution_end",
  // Audit-log corruption detector (FIX-B-2 #4)
  // Surfaced when ensureInstallSalt encounters a parse failure: write the
  // forensic row BEFORE regenerating the salt so the audit trail records
  // what happened.
  "audit_log_corruption_detected",
  // v0.2.2 — TaskState CAS-failure forensics (Architect/Data-Guardian/PE
  // convergence).  Fires when a state-machine transition that should never
  // legally fail under normal flow returns ok:false.  `extra.from` / `to` /
  // `reason` / `context` carry the diagnostic.  `extra.task_id` (when
  // available) carries the stuck task id.  Channel is "system" (daemon-
  // internal bookkeeping).
  "task_state_cas_failed",
  // v0.2.2 — Premature-termination regression alarm (Observability BLESS-W1).
  // Fires when a task_completed audit row's duration_ms < 100ms.  The v0.2.1
  // bug class (IMPL-D-1's null-mapper-symmetry) produced duration_ms=7
  // across all task rows; this audit catches future regressions before they
  // ship.  `duration_ms` carries the actual measurement.
  "task_completed_suspiciously_fast",
  // v0.2.2 — Terminal-state-on-disk recovery (Adversarial re-bless NEW-2 +
  // PE BLESS-B1).  Fires from daemon boot when restoreFromDisk finds a
  // terminal state (completed/failed/cancelled) — indicates a crash between
  // the terminal CAS and the idle flush.  `extra.prior_kind` + `task_id`
  // identify the stuck task; post-incident review can correlate with
  // channel-side delivery records.
  "task_state_recovered_on_restart",
  // v0.2.2 — Channel-side inbound observability promoted from debug→info
  // (per Security BLESS-B1: NO content fields, ONLY message_type +
  // sender_id_hash).  Per Files Touched table.
  "telegram_inbound",
  "whatsapp_inbound",
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
