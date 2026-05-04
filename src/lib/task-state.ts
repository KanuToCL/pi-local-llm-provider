/**
 * TaskState discriminated union + atomic CAS-style transitions for the
 * single-in-flight-task model.
 *
 * Per `~/.llms/plans/pi_comms_daemon.plan.md`:
 *   - §"Phase 1.5 — Single In-Flight Task + TaskState State Machine"
 *     (lines 1002-1080): the type spec, the transition table, the
 *     auto-promote race guard, the cross-restart persistence rules,
 *     and the acceptance gate.
 *   - §"v4.2 confirm() semantics" line 1140: 'confirm_cap' cancellation
 *     reason added to the v4 row set ('user' / 'studio_crash' /
 *     'timeout' / 'shutdown').
 *   - Pitfall #22 (line 1262): in-flight task lost across restart →
 *     state persisted on every transition; on boot, recovery message
 *     sent if state was `running`/`backgrounded`.
 *
 * Architectural intent:
 *   - There is exactly ONE task in flight at any moment. The state
 *     machine encodes that invariant; the daemon refuses to start a
 *     new task unless the current state is `idle`.
 *   - Every transition flows through `transition()`. No direct mutation
 *     of `TaskStateManager`'s internal state from outside the module.
 *   - The auto-promote timer captures a taskId at fire time. When it
 *     fires, it asks `tryTransition` to move `running → backgrounded`
 *     for THAT taskId. If the task has already completed (or been
 *     cancelled) the transition fails and the daemon does NOT emit a
 *     spurious "still working" message. This is the v4 fix for the
 *     auto-promote race that v3's setTimeout approach left open.
 *   - State is persisted to a `JsonStore` after every successful
 *     transition. On daemon boot, `restoreFromDisk` reads the prior
 *     state; if it was `running` or `backgrounded`, the daemon was
 *     killed mid-task. The manager force-resets to `idle` and signals
 *     the abandoned-task details so the daemon can send a recovery
 *     `tell()` to the originating channel.
 *   - The `AbortController` in `running`/`backgrounded` states is
 *     intentionally NOT serialized (it can't cross a process boundary
 *     anyway). On restore, the abort controller is unrecoverable —
 *     which is fine, because the only sensible action post-restart is
 *     "give up and tell the user."
 */

import { JsonStore } from "../storage/json-store.js";

/**
 * The set of channels a task can originate from. Mirrors the closed
 * enumeration used in `src/audit/schema.ts` (which adds 'system' for
 * daemon-internal events; we exclude it here because no user-facing
 * task ever originates from `system`).
 */
export type ChannelId = "terminal" | "whatsapp" | "telegram";

/** Discriminated union over every possible task state. */
export type TaskState =
  | { kind: "idle" }
  | {
      kind: "running";
      taskId: string;
      startedAt: number;
      channel: ChannelId;
      userMessage: string;
      abort: AbortController;
    }
  | {
      kind: "backgrounded";
      taskId: string;
      startedAt: number;
      channel: ChannelId;
      userMessage: string;
      abort: AbortController;
      promotedAt: number;
      promotedBy: "agent" | "auto";
    }
  | {
      kind: "completed";
      taskId: string;
      startedAt: number;
      finishedAt: number;
    }
  | {
      kind: "cancelled";
      taskId: string;
      startedAt: number;
      cancelledAt: number;
      reason: "user" | "studio_crash" | "timeout" | "shutdown" | "confirm_cap";
    }
  | {
      kind: "failed";
      taskId: string;
      startedAt: number;
      finishedAt: number;
      error: string;
    };

/** All possible discriminator values; useful for logs and tests. */
export type TaskStateKind = TaskState["kind"];

/** Transition outcome. `reason` is human-readable, suitable for audit logs. */
export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Static map of allowed transitions, encoding the table from
 * §"Phase 1.5" lines 1021-1033. Edits here MUST be mirrored in
 * `tests/task-state.test.ts` so the test wave catches regressions.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStateKind, readonly TaskStateKind[]>> = {
  idle: ["running"],
  running: ["backgrounded", "completed", "cancelled", "failed"],
  backgrounded: ["completed", "cancelled", "failed"],
  completed: ["idle"],
  cancelled: ["idle"],
  failed: ["idle"],
};

/**
 * Pure-function transition validator. Does NOT mutate any state — that's
 * the `TaskStateManager`'s job. Returns `{ ok: true }` if the edge is
 * legal, otherwise `{ ok: false, reason: '...' }` with a descriptive
 * reason suitable for an audit-log `reason` field.
 *
 * AUDIT-B #17: tasks IDs must MATCH for transitions that semantically
 * "continue" the same task (running→backgrounded, running→completed,
 * running→cancelled, running→failed, backgrounded→completed/cancelled/
 * failed).  Without this check, an auto-promote timer that captured T1
 * could successfully background T2 if the daemon completed T1 + started
 * T2 in the same tick — silently producing a backgrounded T2 with
 * channel/userMessage data lifted from T1.
 */
export function transition(current: TaskState, next: TaskState): TransitionResult {
  const fromKind = current.kind;
  const toKind = next.kind;
  const allowed = ALLOWED_TRANSITIONS[fromKind];
  if (!allowed.includes(toKind)) {
    return {
      ok: false,
      reason: `invalid transition ${fromKind} → ${toKind}`,
    };
  }

  // AUDIT-B #17: taskId-preserving transitions guard.  When both states
  // carry a taskId, they MUST match — otherwise we are silently jumping
  // a transition between two different tasks.
  const currentTaskId =
    "taskId" in current && typeof current.taskId === "string"
      ? current.taskId
      : null;
  const nextTaskId =
    "taskId" in next && typeof next.taskId === "string" ? next.taskId : null;
  if (currentTaskId !== null && nextTaskId !== null && currentTaskId !== nextTaskId) {
    return {
      ok: false,
      reason: `taskId mismatch on ${fromKind} → ${toKind}: current=${currentTaskId} next=${nextTaskId}`,
    };
  }

  return { ok: true };
}

/**
 * Detail bundle for a task that was running/backgrounded when the
 * daemon was killed. Returned by `restoreFromDisk` so the daemon can
 * send the user a recovery message naming the abandoned request.
 */
export interface AbandonedTask {
  taskId: string;
  channel: ChannelId;
  userMessage: string;
  startedAt: number;
}

/**
 * Detail bundle for a task that was found in a TERMINAL state (completed/
 * failed/cancelled) on disk. Per v0.2.2 contract change: terminal states are
 * EPHEMERAL markers that should never persist long-term — `markTerminalAndIdle`
 * awaits the idle-flush before returning. If `restoreFromDisk` finds a
 * terminal state on disk, it indicates a crash between the terminal CAS and
 * the idle flush. The caller (daemon boot) emits a
 * `task_state_recovered_on_restart` audit event with the prior taskId so
 * post-incident review can correlate with channel-side delivery records.
 *
 * Defined per Adversarial re-bless NEW-8.
 */
export interface RecoveredTaskInfo {
  taskId: string;
  priorKind: "completed" | "failed" | "cancelled";
}

/** Outcome of `restoreFromDisk`. */
export interface RestoreResult {
  /** The state the manager was in before the boot (raw, post-deserialize). */
  priorState: TaskState;
  /**
   * Set when the prior state was `running` or `backgrounded` — the daemon
   * crashed mid-task and should send the user a "I crashed; please
   * re-issue" message. `null` when the prior state was a terminal state
   * or `idle`.
   */
  abandoned: AbandonedTask | null;
  /**
   * v0.2.2: set when the prior state was a TERMINAL state
   * (completed/failed/cancelled).  Indicates a crash between the terminal
   * CAS and the idle flush.  The user MAY have received the reply (subscriber
   * fanOut fires before prompt() resolves) or may not.  Daemon caller emits
   * `task_state_recovered_on_restart` audit event so post-incident review can
   * correlate with channel-side delivery records.  `null` when the prior
   * state was `idle`, `running`, `backgrounded`, or absent/corrupt.
   */
  recovered: RecoveredTaskInfo | null;
}

export interface TaskStateManagerOpts {
  /**
   * Absolute path to the persistence file. If both this and `jsonStore`
   * are provided, `jsonStore` wins (intended for tests). If neither is
   * provided, the manager runs in-memory only — safe for unit tests but
   * unsafe for production daemons.
   */
  persistencePath?: string;
  /**
   * Caller-provided store (DI for tests + advanced reuse). Constructed
   * here when only `persistencePath` is given.
   */
  jsonStore?: JsonStore<unknown>;
}

/**
 * Stateful wrapper around `transition()` that:
 *   1. Holds the current `TaskState` in memory.
 *   2. Persists every successful transition to disk (when configured).
 *   3. Provides `restoreFromDisk` for crash-recovery on daemon boot.
 *
 * Single-process invariant: only ONE manager instance per daemon. The
 * `JsonStore`'s write queue is per-instance, so two managers pointing at
 * the same path would race. Daemons enforce single-instance via OS-level
 * mechanisms (named mutex / flock / scheduled-task IgnoreNew) per Phase 4.
 */
export class TaskStateManager {
  private state: TaskState = { kind: "idle" };
  private readonly store: JsonStore<unknown> | null;
  /** In-flight write promise; tests use `flush()` to wait on it. */
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(opts: TaskStateManagerOpts = {}) {
    if (opts.jsonStore) {
      this.store = opts.jsonStore;
    } else if (opts.persistencePath) {
      this.store = new JsonStore<unknown>(opts.persistencePath);
    } else {
      this.store = null;
    }
  }

  /** Snapshot of the current state. Callers should NOT mutate the result. */
  get(): TaskState {
    return this.state;
  }

  /**
   * Attempt a CAS-style transition. On success, mutates internal state
   * and enqueues a persistence write. On failure, leaves state untouched
   * and returns the rejection reason.
   *
   * The race-suppression contract for the auto-promote timer is:
   *   - Timer fires, captures `taskId` from creation time.
   *   - Calls `tryTransition({ kind: 'backgrounded', taskId, ... })`.
   *   - If the task already completed / was cancelled, the from-state
   *     is no longer `running`, so this transition returns `ok: false`
   *     and the daemon suppresses the "still working" message.
   *   - The taskId equality check is the caller's responsibility — the
   *     transition table only enforces kind-level legality.
   */
  tryTransition(next: TaskState): TransitionResult {
    const result = transition(this.state, next);
    if (!result.ok) return result;
    this.state = next;
    if (this.store) {
      this.pendingWrite = this.store.write(serialize(next));
    }
    return result;
  }

  /**
   * Wait for any pending persistence write to drain. Useful in tests
   * and at shutdown. In production, the daemon does NOT need to wait
   * on every write — the `JsonStore` queues internally — but flushing
   * before exit avoids losing the final state-transition write.
   *
   * Per Adversarial re-bless NEW-5: USED by `markTerminalAndIdle` for
   * crash-window safety.  Errors propagate (no swallow) — disk-full or IO
   * errors during terminal-state flush should be loud (caller can audit-log).
   */
  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  /**
   * Atomic terminal-and-idle transition: writes the terminal state to disk
   * (for audit-trail purposes), then immediately writes idle to disk so the
   * state machine returns to its single resting state. Both writes go through
   * JsonStore's serial queue (FIFO-guaranteed), and we await the IDLE write
   * to flush before returning so a crash post-call cannot leave the daemon
   * trapped in a terminal state.
   *
   * This is the SINGLE PATH to a terminal state in v0.2.2. Every caller
   * (handleInbound's mark helpers, watchdog, /cancel) MUST use this. The
   * cyclicity guard at handleInbound entry is defense-in-depth only.
   *
   * Returns the original CAS result so callers can audit-log + react. If
   * the terminal CAS fails (e.g., race with another terminator), returns
   * { ok: false, reason } and does NOT attempt the idle CAS.
   *
   * Per Architect BLESS-B2 + Data Guardian BLESS-B1: instead of every
   * consumer doing the running→completed→idle two-step dance with crash-
   * window vulnerability, the state machine itself owns the invariant.
   */
  async markTerminalAndIdle(
    terminal: TaskState & { kind: "completed" | "failed" | "cancelled" },
  ): Promise<TransitionResult> {
    const terminalResult = this.tryTransition(terminal);
    if (!terminalResult.ok) {
      return terminalResult;
    }

    // Idle CAS: should always succeed (terminal → idle is in transition table).
    // If it doesn't, something has gone deeply wrong; return the failure
    // so the caller can audit-log it as a state-machine inconsistency.
    const idleResult = this.tryTransition({ kind: "idle" });
    if (!idleResult.ok) {
      return idleResult;
    }

    // Crash-window safety: await the idle write to flush before returning.
    // Without this, a crash between the in-memory CAS and the JsonStore
    // write leaves disk in `terminal` state, which the cyclicity guard at
    // handleInbound entry can recover from but produces audit-trail noise.
    // Per Data Guardian BLESS-B1.  Per Adversarial re-bless NEW-5: USE the
    // EXISTING flush() method (line above).  Errors propagate (no swallow).
    await this.flush();

    return { ok: true };
  }

  /**
   * Read the persisted state, force the manager to `idle`, and return a
   * recovery descriptor. The daemon calls this exactly once on boot,
   * BEFORE accepting any inbound work.
   *
   * Behavior:
   *   - Missing/corrupt file → priorState=idle, abandoned=null,
   *     recovered=null. Safe to proceed.
   *   - `idle` persisted → priorState=that, abandoned=null, recovered=null.
   *   - `running` / `backgrounded` persisted → priorState=that,
   *     abandoned={taskId, channel, userMessage, startedAt}. The daemon
   *     SHOULD emit a `task_abandoned_on_restart` audit event and a
   *     `tell()` to the originating channel.
   *   - `completed` / `cancelled` / `failed` persisted →
   *     priorState=that, recovered={taskId, priorKind}.
   *
   * Pre-v0.2.2: terminal states (completed/failed/cancelled) on disk meant
   * "task ran cleanly to completion before previous shutdown." Drained to idle
   * silently.
   *
   * v0.2.2 contract change: terminal states are EPHEMERAL markers that should
   * never persist long-term — `markTerminalAndIdle` awaits the idle-flush
   * before returning. If we find a terminal state on disk, it indicates a
   * crash between the terminal CAS and the idle flush. The user MAY have
   * received the reply (subscriber fanOut fires before prompt() resolves) or
   * may not. Caller emits `task_state_recovered_on_restart` audit event with
   * the prior taskId so post-incident review can correlate with channel-side
   * delivery records.
   *
   * Always sets `this.state = idle` regardless of prior state.
   *
   * Per Adversarial re-bless NEW-4: PRESERVE the existing `priorState` field
   * in RestoreResult — callers (session.ts:321 + tests/task-state.test.ts)
   * depend on it. `recovered` is a NEW field added in v0.2.2; priorState is
   * NOT removed.
   */
  async restoreFromDisk(): Promise<RestoreResult> {
    if (!this.store) {
      // No persistence configured — boot fresh.
      return {
        priorState: { kind: "idle" },
        abandoned: null,
        recovered: null,
      };
    }
    const raw = await this.store.read();
    const priorState = deserialize(raw);
    let abandoned: AbandonedTask | null = null;
    let recovered: RecoveredTaskInfo | null = null;
    if (priorState.kind === "running" || priorState.kind === "backgrounded") {
      abandoned = {
        taskId: priorState.taskId,
        channel: priorState.channel,
        userMessage: priorState.userMessage,
        startedAt: priorState.startedAt,
      };
    } else if (
      priorState.kind === "completed" ||
      priorState.kind === "cancelled" ||
      priorState.kind === "failed"
    ) {
      // v0.2.2: terminal state on disk = crash between terminal CAS and
      // idle flush.  Caller (daemon boot) emits
      // `task_state_recovered_on_restart` audit event.
      recovered = { taskId: priorState.taskId, priorKind: priorState.kind };
    }
    // Force the manager to a usable starting state. Only persist if the
    // prior on-disk state actually differed from `idle` — avoids
    // gratuitous I/O on every cold boot and avoids a tempdir-race in
    // tests where the workDir is removed before the queued write runs.
    this.state = { kind: "idle" };
    if (this.store && priorState.kind !== "idle") {
      this.pendingWrite = this.store.write(serialize(this.state));
    }
    return { priorState, abandoned, recovered };
  }
}

/**
 * Strip non-serializable fields (AbortController) before persisting.
 * Returns a plain object snapshot suitable for `JSON.stringify`.
 */
function serialize(state: TaskState): unknown {
  if (state.kind === "running" || state.kind === "backgrounded") {
    // Pull `abort` out of the destructure; the rest is plain data.
    const { abort: _abort, ...rest } = state;
    void _abort;
    return rest;
  }
  return state;
}

/**
 * Best-effort deserialize. The JsonStore returns `unknown`; we shape-check
 * defensively and fall back to `idle` on anything we don't recognise.
 *
 * For `running` / `backgrounded` we re-attach a fresh `AbortController` —
 * it can't survive a process boundary, but the manager always force-
 * transitions to `idle` after restore anyway, so the controller is never
 * actually used. We attach one only to keep the discriminated union
 * type-honest.
 */
function deserialize(raw: unknown): TaskState {
  if (!raw || typeof raw !== "object") return { kind: "idle" };
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;

  if (kind === "idle") return { kind: "idle" };

  if (kind === "running" && hasTaskShape(obj) && hasChannelShape(obj)) {
    return {
      kind: "running",
      taskId: obj.taskId as string,
      startedAt: obj.startedAt as number,
      channel: obj.channel as ChannelId,
      userMessage: obj.userMessage as string,
      abort: new AbortController(),
    };
  }

  if (kind === "backgrounded" && hasTaskShape(obj) && hasChannelShape(obj)) {
    const promotedAt =
      typeof obj.promotedAt === "number" ? (obj.promotedAt as number) : 0;
    const promotedBy =
      obj.promotedBy === "agent" || obj.promotedBy === "auto"
        ? (obj.promotedBy as "agent" | "auto")
        : "auto";
    return {
      kind: "backgrounded",
      taskId: obj.taskId as string,
      startedAt: obj.startedAt as number,
      channel: obj.channel as ChannelId,
      userMessage: obj.userMessage as string,
      abort: new AbortController(),
      promotedAt,
      promotedBy,
    };
  }

  if (
    kind === "completed" &&
    typeof obj.taskId === "string" &&
    typeof obj.startedAt === "number" &&
    typeof obj.finishedAt === "number"
  ) {
    return {
      kind: "completed",
      taskId: obj.taskId as string,
      startedAt: obj.startedAt as number,
      finishedAt: obj.finishedAt as number,
    };
  }

  if (
    kind === "cancelled" &&
    typeof obj.taskId === "string" &&
    typeof obj.startedAt === "number" &&
    typeof obj.cancelledAt === "number" &&
    isCancelReason(obj.reason)
  ) {
    return {
      kind: "cancelled",
      taskId: obj.taskId as string,
      startedAt: obj.startedAt as number,
      cancelledAt: obj.cancelledAt as number,
      reason: obj.reason,
    };
  }

  if (
    kind === "failed" &&
    typeof obj.taskId === "string" &&
    typeof obj.startedAt === "number" &&
    typeof obj.finishedAt === "number" &&
    typeof obj.error === "string"
  ) {
    return {
      kind: "failed",
      taskId: obj.taskId as string,
      startedAt: obj.startedAt as number,
      finishedAt: obj.finishedAt as number,
      error: obj.error as string,
    };
  }

  // Unknown shape — safe default.
  return { kind: "idle" };
}

function hasTaskShape(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.taskId === "string" &&
    typeof obj.startedAt === "number" &&
    typeof obj.userMessage === "string"
  );
}

function hasChannelShape(obj: Record<string, unknown>): boolean {
  return (
    obj.channel === "terminal" ||
    obj.channel === "whatsapp" ||
    obj.channel === "telegram"
  );
}

function isCancelReason(
  v: unknown
): v is "user" | "studio_crash" | "timeout" | "shutdown" | "confirm_cap" {
  return (
    v === "user" ||
    v === "studio_crash" ||
    v === "timeout" ||
    v === "shutdown" ||
    v === "confirm_cap"
  );
}
