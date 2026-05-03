/**
 * SessionAckTracker — RS-6 session-boundary detection for `/unsand`.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md §"v4.2 Session boundary precisely
 * defined" + §"v4.2 Tool-result-derived /unsand": the next `/unsand` requires
 * terminal-side ack if ANY of:
 *
 *   (a) >24h since last terminal-ack
 *   (b) daemon restarted since last terminal-ack
 *   (c) /lock issued and unlocked since last terminal-ack
 *   (d) /alive missed and recovered since last terminal-ack
 *   (e) request flagged tool-derived (set when slash-router sees a /unsand
 *       invocation that came from a recently-tool-result-derived agent
 *       message)
 *
 * Replaces the hardcoded `isFirstUnsandPerSession: () => true` and
 * `getUnsandRequiresTerminalAck: () => false` in daemon.ts.
 *
 * Persistence:
 *   - State persisted via JsonStore to `~/.pi-comms/session-ack-tracker.json`.
 *   - `daemonStartTs` is captured on every construction; if the persisted
 *     `lastDaemonStartAtTerminalAck` does not match the current daemon
 *     start, rule (b) fires.
 *
 * Forensic semantics:
 *   - All five rules are independent triggers; the tracker reports
 *     `requiresTerminalAck` = OR of all five.
 *   - `recordTerminalAck()` clears (a)-(d) state by setting all four
 *     "since last terminal-ack" trackers to "no event since now".
 *   - `flagToolDerived(taskId)` is per-task: clearing happens implicitly
 *     when the next `requiresTerminalAck()` is queried for a different
 *     taskId or when the per-task flag is cleared via the slash-router on
 *     terminal ack.
 *
 * Threading:
 *   - All public methods are synchronous from caller perspective; persistence
 *     writes are enqueued through the JsonStore and may be awaited via
 *     `flush()` at shutdown for durability.
 */

import type { JsonStore } from "../storage/json-store.js";

// ---------------------------------------------------------------------------
// Persisted state shape
// ---------------------------------------------------------------------------

/**
 * On-disk shape. All timestamps are `Date.now()`-style ms since epoch.
 *
 * `lastTerminalAckTs`: when the user last ran `/unsand` from the terminal
 *   (which is the canonical session-ack signal).  null = never.
 *
 * `lastDaemonStartAtTerminalAck`: snapshot of `daemonStartTs` taken at the
 *   moment of the last terminal-ack.  When the current daemon's start
 *   timestamp differs, rule (b) — daemon restart — fires.  null = never.
 *
 * `lockCycleSinceAckAt`: when a /lock+/unlock cycle completed after the
 *   last terminal-ack.  When non-null, rule (c) fires.  Cleared on next
 *   terminal-ack.
 *
 * `aliveMissSinceAckAt`: when an /alive miss was detected and recovered
 *   since the last terminal-ack.  When non-null, rule (d) fires.  Cleared
 *   on next terminal-ack.
 */
export interface SessionAckPersistedState {
  lastTerminalAckTs: number | null;
  lastDaemonStartAtTerminalAck: number | null;
  lockCycleSinceAckAt: number | null;
  aliveMissSinceAckAt: number | null;
}

const DEFAULT_STATE: SessionAckPersistedState = {
  lastTerminalAckTs: null,
  lastDaemonStartAtTerminalAck: null,
  lockCycleSinceAckAt: null,
  aliveMissSinceAckAt: null,
};

// ---------------------------------------------------------------------------
// Public — context for requiresTerminalAck() decisions
// ---------------------------------------------------------------------------

/**
 * Per-call context for `requiresTerminalAck`. The taskId lets us scope
 * the tool-derived flag to one task — a /unsand from task A should not be
 * gated by a tool-derived flag set on task B.
 */
export interface SessionAckCheckContext {
  /** Optional task id; if set, we OR in the per-task tool-derived flag. */
  taskId?: string | null;
}

// ---------------------------------------------------------------------------
// Public — SessionAckTracker
// ---------------------------------------------------------------------------

export interface SessionAckTrackerOpts {
  /** Atomic-write JSON store for persistence. */
  jsonStore: JsonStore<SessionAckPersistedState>;
  /** Current daemon start timestamp (ms). Used by rule (b). */
  daemonStartTs: number;
  /**
   * Window beyond which rule (a) fires.  Defaults to 24h.  Tests inject
   * a smaller value.
   */
  ackTtlMs?: number;
  /** Time source (ms). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_ACK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SessionAckTracker {
  private readonly store: JsonStore<SessionAckPersistedState>;
  private readonly daemonStartTs: number;
  private readonly ackTtlMs: number;
  private readonly now: () => number;

  /** In-memory copy of the persisted state.  Loaded by `load()`. */
  private state: SessionAckPersistedState = { ...DEFAULT_STATE };

  /**
   * Per-task tool-derived flag (rule e).  Set when a `/unsand` invocation
   * was triggered by a recent tool-result-derived agent message.  Cleared
   * implicitly on the next `recordTerminalAck()` (we keep the most recent
   * flag only; new tasks get fresh flags as the slash-router sees them).
   */
  private toolDerivedTaskIds = new Set<string>();

  /** In-flight write so callers can `flush()` at shutdown. */
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(opts: SessionAckTrackerOpts) {
    this.store = opts.jsonStore;
    this.daemonStartTs = opts.daemonStartTs;
    this.ackTtlMs = opts.ackTtlMs ?? DEFAULT_ACK_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Load persisted state from disk. Call once at boot. If the file is
   * missing or corrupt, the tracker remains in the default (all-null)
   * state, which makes `requiresTerminalAck()` return true via rule (a)
   * — the conservative default.
   */
  async load(): Promise<void> {
    const raw = await this.store.read();
    if (raw && typeof raw === "object") {
      // Defensive shape check — anything missing falls back to default.
      this.state = {
        lastTerminalAckTs:
          typeof raw.lastTerminalAckTs === "number"
            ? raw.lastTerminalAckTs
            : null,
        lastDaemonStartAtTerminalAck:
          typeof raw.lastDaemonStartAtTerminalAck === "number"
            ? raw.lastDaemonStartAtTerminalAck
            : null,
        lockCycleSinceAckAt:
          typeof raw.lockCycleSinceAckAt === "number"
            ? raw.lockCycleSinceAckAt
            : null,
        aliveMissSinceAckAt:
          typeof raw.aliveMissSinceAckAt === "number"
            ? raw.aliveMissSinceAckAt
            : null,
      };
    }
  }

  /**
   * Wait for any pending persistence write to drain. Useful at shutdown
   * so the most recent state lands on disk.
   */
  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  /**
   * Returns true when the next `/unsand` requires terminal-side ack
   * because at least one of rules (a)-(e) fires.
   */
  requiresTerminalAck(ctx: SessionAckCheckContext = {}): boolean {
    return this.firingRules(ctx).length > 0;
  }

  /**
   * Returns the list of rule labels that currently fire.  Useful for
   * audit-log diagnostics so post-incident review can see WHY a /unsand
   * was gated.  Empty array means no rules fire — terminal-ack is not
   * required.
   */
  firingRules(ctx: SessionAckCheckContext = {}): string[] {
    const fires: string[] = [];
    const now = this.now();

    // Rule (a): >24h since last terminal-ack (or never).
    if (
      this.state.lastTerminalAckTs === null ||
      now - this.state.lastTerminalAckTs > this.ackTtlMs
    ) {
      fires.push("ttl_expired");
    }

    // Rule (b): daemon restarted since last terminal-ack.
    if (
      this.state.lastDaemonStartAtTerminalAck === null ||
      this.state.lastDaemonStartAtTerminalAck !== this.daemonStartTs
    ) {
      fires.push("daemon_restart");
    }

    // Rule (c): /lock cycle since last terminal-ack.
    if (this.state.lockCycleSinceAckAt !== null) {
      fires.push("lock_cycle");
    }

    // Rule (d): /alive miss recovered since last terminal-ack.
    if (this.state.aliveMissSinceAckAt !== null) {
      fires.push("alive_miss");
    }

    // Rule (e): tool-derived flag for the requesting task.
    if (ctx.taskId && this.toolDerivedTaskIds.has(ctx.taskId)) {
      fires.push("tool_derived");
    }

    return fires;
  }

  /**
   * Record a successful terminal-side `/unsand` ack.  Clears (a)-(e):
   *   - sets `lastTerminalAckTs` and `lastDaemonStartAtTerminalAck` to now
   *   - clears `lockCycleSinceAckAt` and `aliveMissSinceAckAt` to null
   *   - clears every `toolDerivedTaskIds` entry
   */
  recordTerminalAck(): void {
    const now = this.now();
    this.state = {
      lastTerminalAckTs: now,
      lastDaemonStartAtTerminalAck: this.daemonStartTs,
      lockCycleSinceAckAt: null,
      aliveMissSinceAckAt: null,
    };
    this.toolDerivedTaskIds.clear();
    this.persist();
  }

  /**
   * Record that a /lock+/unlock cycle just completed.  Rule (c) will fire
   * on the next requiresTerminalAck() until a new terminal-ack.
   */
  recordLockCycle(): void {
    this.state = {
      ...this.state,
      lockCycleSinceAckAt: this.now(),
    };
    this.persist();
  }

  /**
   * Record that an /alive miss was detected (with subsequent recovery).
   * Rule (d) will fire on the next requiresTerminalAck() until a new
   * terminal-ack.
   */
  recordAliveMiss(): void {
    this.state = {
      ...this.state,
      aliveMissSinceAckAt: this.now(),
    };
    this.persist();
  }

  /**
   * Flag a task as "this /unsand came from a tool-result-derived agent
   * message."  The slash-router sets this when it observes the inbound
   * came from the agent message stream rather than directly from the
   * user.  Per task-id so it doesn't bleed across tasks.
   */
  flagToolDerived(taskId: string): void {
    if (!taskId) return;
    this.toolDerivedTaskIds.add(taskId);
    // No persistence — tool-derived flags are session-local and clear on
    // any terminal-ack or process restart.
  }

  /**
   * Snapshot of the current state.  Useful for `/status` and tests.
   */
  snapshot(): {
    state: SessionAckPersistedState;
    daemonStartTs: number;
    toolDerivedTaskIds: string[];
  } {
    return {
      state: { ...this.state },
      daemonStartTs: this.daemonStartTs,
      toolDerivedTaskIds: [...this.toolDerivedTaskIds],
    };
  }

  // -------------------------------------------------------------------
  // Internal — persistence
  // -------------------------------------------------------------------

  private persist(): void {
    this.pendingWrite = this.store.write({ ...this.state });
    // Don't poison the queue on failure — caller may flush() to discover.
    this.pendingWrite.catch(() => undefined);
  }
}
