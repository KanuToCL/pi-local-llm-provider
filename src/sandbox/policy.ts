/**
 * Runtime sandbox policy + `/unsand` state machine.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"v4.1 — `/unsand` escape hatch" (line 1387): three grant scopes
 *     (`next-task` default, `<minutes>` window, `off` immediate re-engage).
 *   - §"v4.2 Sandbox state on daemon boot" (line 1483): boot ALWAYS restores
 *     the most-restrictive posture (engaged), regardless of any persisted
 *     un-sand window. Persisted state is loaded then overwritten with
 *     `{kind: 'engaged'}`; an audit event records the discarded prior state
 *     so post-incident review can correlate.
 *   - §"v4.2 Tool-result-derived `/unsand`" (line 1500): tool-derived grants
 *     require terminal-side ack regardless of session age. The policy stores
 *     this flag on the active grant (forensic visibility) but the gate that
 *     enforces "needs terminal ack" lives upstream in the `/unsand` command
 *     handler — `disable()` accepts a `sessionAck` boolean and refuses the
 *     transition without it whenever the request is `toolDerived: true`.
 *   - §"v4.1 Pitfall #31" (line 1434): hard cap on `/unsand <minutes>` at
 *     120 minutes. Any larger value is rejected with `exceeds_max_window_120`.
 *   - §"v4.2 Session boundary precisely defined" (line 1509): the policy
 *     itself does NOT track the (a)-(d) session-boundary signals — those are
 *     evaluated upstream by the command handler, which then passes the
 *     resulting `firstPerSession` flag to `disable()`. The policy records
 *     it on the grant for forensic reasoning.
 *
 * Persistence:
 *   - All durable state is written through a `JsonStore<SandboxState>` — the
 *     IMPL-4 W1 atomic write pattern. The policy holds an in-memory copy
 *     and writes asynchronously after every transition so reads (the hot
 *     path) stay synchronous.
 *   - `forceEngagedOnBoot()` is the single supported boot entry point; it
 *     emits `sandbox_force_engaged_on_boot` with the discarded prior-state
 *     scope + expiry so the audit trail captures the disarm even though
 *     the runtime moves on.
 *
 * Threading:
 *   - All public methods are synchronous from the caller's perspective; the
 *     `JsonStore.write()` they enqueue serializes through the store's own
 *     write queue. There is no fsync — the store keeps the same atomic
 *     temp+rename guarantee as the rest of the daemon's persisted state.
 */

import type { JsonStore } from "../storage/json-store.js";
import type { AuditLog } from "../audit/log.js";

/** Hard cap on `/unsand <minutes>` per Pitfall #31. */
export const MAX_UNSAND_WINDOW_MINUTES = 120;

/**
 * Two grant scopes per plan §"v4.1":
 *   - `next-task`: re-engage on the next `onTaskCompleted()` callback.
 *   - `window`: re-engage when wall-clock passes `expiresAt`.
 */
export type SandboxScope = "next-task" | "window";

/**
 * The runtime posture. `engaged` is the safe default; anything else
 * carries the metadata needed to reason about expiry and forensics.
 */
export type SandboxState =
  | { kind: "engaged" }
  | {
      kind: "unsand";
      scope: SandboxScope;
      /** Wall-clock ms when the window closes; null for `next-task` scope. */
      expiresAt: number | null;
      /** Wall-clock ms when the grant was issued. */
      grantedAt: number;
      /**
       * True when the upstream command handler classified the request as
       * derived from a tool result (file read, web fetch, bash output).
       * Persisted for forensic visibility per v4.2 RS-6 (revised).
       */
      toolDerivedFlag: boolean;
      /**
       * True when this was the first `/unsand` after a fresh session
       * boundary (defined by the upstream handler per v4.2 §"Session
       * boundary precisely defined").
       */
      firstPerSession: boolean;
    };

export interface SandboxPolicyOptions {
  /** Persisted store of the current state. */
  jsonStore: JsonStore<SandboxState>;
  /**
   * Optional audit log. When provided, the policy emits
   * `sandbox_force_engaged_on_boot` / `unsand_enabled` / `unsand_disabled`
   * events on every transition. Tests can omit it to keep assertions on
   * pure state-machine behavior.
   */
  auditLog?: AuditLog;
}

export interface DisableOptions {
  scope: SandboxScope;
  /** Required when `scope === 'window'`; ignored otherwise. */
  windowMinutes?: number;
  /** True if the request was flagged tool-derived by the command handler. */
  toolDerived: boolean;
  /**
   * True when the upstream command handler has confirmed terminal-side
   * acknowledgment (first-per-session OR tool-derived flow). The policy
   * refuses the transition without it whenever ack would be required.
   */
  sessionAck: boolean;
  /**
   * True if the upstream handler classified this as the first `/unsand`
   * after a fresh session boundary. Captured on the grant for forensics.
   */
  firstPerSession?: boolean;
  /**
   * AUDIT-B #16: forensic context.  When the request was triggered as a
   * follow-up to a tool result, the upstream handler should pass the
   * task id whose tool output prompted the user.  Recorded on
   * `unsand_enabled` audit so post-incident review can correlate.
   */
  triggeringTaskId?: string;
  /**
   * AUDIT-B #16: hash of the user-message text that triggered the
   * request (NOT the raw text — privacy).  Recorded on `unsand_enabled`
   * audit.  Empty string when not provided.
   */
  triggeringUserMessageHash?: string;
  /**
   * AUDIT-B #16: free-form rationale the AGENT supplied (when the
   * grant was tool-derived).  Recorded verbatim on `unsand_enabled`
   * audit (truncated to 500 chars).  Empty string when not provided.
   */
  agentRationaleText?: string;
  /** Optional clock injection for tests. */
  now?: number;
}

export interface DisableResult {
  ok: boolean;
  reason?:
    | "exceeds_max_window_120"
    | "missing_window_minutes"
    | "missing_session_ack"
    | "missing_tool_derived_ack";
  newState?: SandboxState;
}

export interface TickResult {
  stateChanged: boolean;
  newState: SandboxState;
}

/**
 * The runtime policy. Construct one per daemon and share it across the
 * command handler, the bash-tool wrapper, and the periodic tick driver
 * (which calls `tickExpiration()` from the same place that drives
 * heartbeats).
 */
export class SandboxPolicy {
  private state: SandboxState = { kind: "engaged" };
  private readonly jsonStore: JsonStore<SandboxState>;
  private readonly auditLog: AuditLog | undefined;

  constructor(opts: SandboxPolicyOptions) {
    this.jsonStore = opts.jsonStore;
    this.auditLog = opts.auditLog;
  }

  /** Hot-path query — synchronous, no I/O. */
  isSandboxed(): boolean {
    return this.state.kind === "engaged";
  }

  /** Read-only accessor for callers that need full state context. */
  getState(): SandboxState {
    return this.state;
  }

  /**
   * Re-engage the sandbox immediately. Used by `/unsand off` and by the
   * task-completion callback for `next-task` scope. Idempotent.
   */
  enable(): void {
    if (this.state.kind === "engaged") return;
    const prior = this.state;
    this.state = { kind: "engaged" };
    this.persist();
    if (this.auditLog) {
      void this.auditLog
        .append({
          event: "unsand_disabled",
          task_id: null,
          channel: "system",
          sender_id_hash: null,
          extra: {
            reason: "user_off",
            prior_scope: prior.scope,
            prior_expires_at: prior.expiresAt ?? 0,
          },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Open an un-sand grant per plan §"v4.1". Validation:
   *   1. `windowMinutes` required (and > 0) when `scope === 'window'`.
   *   2. `windowMinutes` must not exceed 120 (Pitfall #31).
   *   3. `sessionAck` is required whenever the grant is `toolDerived` (per
   *      v4.2 RS-6 revised) OR `firstPerSession` (per v4.1 RS-6 original).
   *
   * Returns `{ok: false, reason}` on validation failure (state untouched);
   * `{ok: true, newState}` on success.
   */
  disable(opts: DisableOptions): DisableResult {
    const now = opts.now ?? Date.now();

    let expiresAt: number | null = null;
    if (opts.scope === "window") {
      if (
        typeof opts.windowMinutes !== "number" ||
        !Number.isFinite(opts.windowMinutes) ||
        opts.windowMinutes <= 0
      ) {
        return { ok: false, reason: "missing_window_minutes" };
      }
      if (opts.windowMinutes > MAX_UNSAND_WINDOW_MINUTES) {
        return { ok: false, reason: "exceeds_max_window_120" };
      }
      expiresAt = now + Math.floor(opts.windowMinutes * 60_000);
    }

    const firstPerSession = opts.firstPerSession === true;

    // Per v4.2 RS-6 (revised): tool-derived grants need ack regardless of
    // session age. Per v4.1 RS-6 (original): first-per-session grants also
    // need ack. Both can be true; either alone gates the transition.
    if (opts.toolDerived && !opts.sessionAck) {
      return { ok: false, reason: "missing_tool_derived_ack" };
    }
    if (firstPerSession && !opts.sessionAck) {
      return { ok: false, reason: "missing_session_ack" };
    }

    const next: SandboxState = {
      kind: "unsand",
      scope: opts.scope,
      expiresAt,
      grantedAt: now,
      toolDerivedFlag: opts.toolDerived,
      firstPerSession,
    };
    this.state = next;
    this.persist();
    if (this.auditLog) {
      // AUDIT-B #16: enrich `unsand_enabled` with caller-supplied
      // forensic fields.  All optional; empty-string fallback so
      // post-mortem queries always see the keys even when unset.
      const extra: Record<string, string | number | boolean> = {
        scope: next.scope,
        expires_at: next.expiresAt ?? 0,
        tool_derived: next.toolDerivedFlag,
        first_per_session: next.firstPerSession,
        triggering_task_id: opts.triggeringTaskId ?? "",
        triggering_user_message_hash: opts.triggeringUserMessageHash ?? "",
        agent_rationale_text: (opts.agentRationaleText ?? "").slice(0, 500),
      };
      void this.auditLog
        .append({
          event: "unsand_enabled",
          task_id: opts.triggeringTaskId ?? null,
          channel: "system",
          sender_id_hash: null,
          extra,
        })
        .catch(() => undefined);
    }
    return { ok: true, newState: next };
  }

  /**
   * Driven by the daemon's heartbeat tick (or by tests injecting a clock).
   * Re-engages the sandbox if a `window`-scoped grant has expired.
   * Returns whether the state changed so callers can emit the user-visible
   * `tell()` notification described in v4.1.
   */
  tickExpiration(now: number): TickResult {
    if (this.state.kind !== "unsand") {
      return { stateChanged: false, newState: this.state };
    }
    if (this.state.scope !== "window") {
      return { stateChanged: false, newState: this.state };
    }
    if (this.state.expiresAt === null) {
      return { stateChanged: false, newState: this.state };
    }
    if (now < this.state.expiresAt) {
      return { stateChanged: false, newState: this.state };
    }
    this.state = { kind: "engaged" };
    this.persist();
    if (this.auditLog) {
      void this.auditLog
        .append({
          event: "unsand_disabled",
          task_id: null,
          channel: "system",
          sender_id_hash: null,
          extra: { reason: "window_expired" },
        })
        .catch(() => undefined);
    }
    return { stateChanged: true, newState: this.state };
  }

  /**
   * Per v4.2 §"Sandbox state on daemon boot": reads any persisted state,
   * unconditionally overwrites it with `{kind: 'engaged'}`, and emits an
   * audit event recording the discarded prior posture. Returns the (always
   * `engaged`) post-boot state.
   *
   * This is the only supported way to bring the policy online at boot.
   * Callers must NOT trust persisted state; the persisted file exists for
   * forensic audit, not for restoration.
   */
  async forceEngagedOnBoot(now: number): Promise<SandboxState> {
    let prior: SandboxState | null = null;
    try {
      prior = await this.jsonStore.read();
    } catch {
      prior = null;
    }
    this.state = { kind: "engaged" };
    // Persist the engaged posture so a second boot reads the corrected
    // state instead of the stale unsand window.
    this.persist();
    if (this.auditLog) {
      const extra: Record<string, string | number | boolean> = {
        reason: "boot",
        boot_now: now,
      };
      if (prior && prior.kind === "unsand") {
        extra.prior_kind = "unsand";
        extra.prior_scope = prior.scope;
        extra.prior_expires_at = prior.expiresAt ?? 0;
        extra.prior_granted_at = prior.grantedAt;
        extra.prior_tool_derived = prior.toolDerivedFlag;
      } else {
        extra.prior_kind = prior?.kind ?? "unknown";
      }
      void this.auditLog
        .append({
          event: "sandbox_force_engaged_on_boot",
          task_id: null,
          channel: "system",
          sender_id_hash: null,
          extra,
        })
        .catch(() => undefined);
    }
    return this.state;
  }

  /**
   * Called by the daemon's task lifecycle when a task completes (finished,
   * failed, cancelled, or abandoned). Re-engages the sandbox iff the active
   * grant was `next-task`. `window` scopes outlive task boundaries by design.
   */
  onTaskCompleted(): void {
    if (this.state.kind !== "unsand") return;
    if (this.state.scope !== "next-task") return;
    this.state = { kind: "engaged" };
    this.persist();
    if (this.auditLog) {
      void this.auditLog
        .append({
          event: "unsand_disabled",
          task_id: null,
          channel: "system",
          sender_id_hash: null,
          extra: { reason: "task_completed" },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Best-effort persist. Errors are swallowed because the in-memory state
   * is the source of truth at runtime — a transient disk failure must not
   * crash the daemon. The next successful write will catch the file up.
   */
  private persist(): void {
    void this.jsonStore.write(this.state).catch(() => undefined);
  }
}
