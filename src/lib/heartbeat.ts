/**
 * Message-loop-touched heartbeat (PE Skeptic Round 2 finding #2).
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md §"Heartbeat liveness from
 * message-loop" (line 1491-1498) and §"Phase 4.0 (NEW) Dead-man switch
 * independent of daemon" (line 1151):
 *
 *   "Heartbeat is touched only after a successful Baileys event poll
 *    AND a successful pi-mono session ping in the last N seconds, NOT
 *    from a `setInterval(touchHeartbeat, 30000)`. A daemon deadlocked
 *    in a tool call but whose Node event loop still runs the timer
 *    would otherwise look healthy."
 *
 * Three-state model:
 *   - `healthy`  — every required source touched in the last `healthyMaxAgeMs`
 *   - `degraded` — at least one source older than `healthyMaxAgeMs` but the
 *                  freshest source is younger than `degradedMaxAgeMs`
 *   - `dead`     — the freshest source is older than `degradedMaxAgeMs`
 *
 * Required sources:
 *   - `baileys-poll` (only when WhatsApp is enabled; see `requiredSources`)
 *   - `telegram-poll`
 *   - `pi-ping` (pi-mono SessionManager keep-alive)
 *
 * The heartbeat *file* (`~/.pi-comms/daemon.heartbeat`) is the durable
 * signal that the cron-style dead-man switch (`scripts/dead-man.sh`) reads.
 * The file's mtime reflects the most recent moment when ALL required
 * sources were healthy. If any required source is stale, the file is NOT
 * touched — so a deadlocked daemon cannot fool the dead-man switch even
 * though its Node event loop is still alive.
 *
 * State-transition audit emission:
 *   - On entry to `degraded` or `dead` (from `healthy`): `pi_stuck_suspected`
 *   - On entry to `healthy` (from `degraded` or `dead`): `pi_heartbeat`
 *   - The very first transition from "no observation yet" emits no event;
 *     we don't know which side of the boundary the system was on.
 */

import { mkdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AuditLog } from "../audit/log.js";
import { OperatorLogger } from "../utils/operator-logger.js";

/** Three-state liveness gauge. */
export type HeartbeatState = "healthy" | "degraded" | "dead";

/**
 * Sources that may touch the heartbeat. Calling `touchAlive` with any
 * other string rejects — we want a closed enumeration so a typo cannot
 * silently park a dead source as "fresh".
 */
export type HeartbeatSource = "baileys-poll" | "telegram-poll" | "pi-ping";

const ALL_SOURCES: readonly HeartbeatSource[] = [
  "baileys-poll",
  "telegram-poll",
  "pi-ping",
];

export interface HeartbeatOpts {
  /** Absolute path of the durable heartbeat file (typically `~/.pi-comms/daemon.heartbeat`). */
  heartbeatPath: string;
  /**
   * Threshold below which every required source is considered "fresh".
   * If every required source is younger than this, the file is touched.
   * Default 90_000 (90s), per plan line 1496.
   */
  healthyMaxAgeMs: number;
  /**
   * Threshold above which the heartbeat is "dead". The freshest required
   * source older than this puts the gauge in `dead`. Default 180_000
   * (3 min), per plan line 1498.
   */
  degradedMaxAgeMs: number;
  /**
   * Subset of sources actually required for healthy. Defaults to all three.
   * If WhatsApp is not configured, the daemon should construct the
   * Heartbeat with `requiredSources: ['telegram-poll', 'pi-ping']` so the
   * gauge does not pin at degraded forever.
   */
  requiredSources?: readonly HeartbeatSource[];
  /** Optional audit log for state-transition events. */
  auditLog?: AuditLog;
  /** Optional operator logger for debug-style tracing. */
  operatorLogger?: OperatorLogger;
  /**
   * Time source (ms since epoch). Defaults to `Date.now`. Tests inject a
   * fake clock; production never overrides.
   */
  now?: () => number;
}

/**
 * Result of `getState()` — the current state plus per-source ages so the
 * caller (e.g. `/status` slash command) can show which source is stale.
 */
export interface HeartbeatSnapshot {
  state: HeartbeatState;
  /** ms since each source last touched, or null if never. */
  ages: Record<HeartbeatSource, number | null>;
  /** ms since the heartbeat file was last written, or null if never written. */
  fileAgeMs: number | null;
}

/**
 * Class invariant: `lastTouches[s]` is `null` if source `s` has never
 * been touched, else the `Date.now()`-style ms timestamp of the most
 * recent successful touch.
 *
 * The heartbeat file mirrors the freshest moment at which ALL required
 * sources were healthy. It is written atomically (temp + rename) so the
 * dead-man switch always sees a consistent mtime.
 */
export class Heartbeat {
  private readonly heartbeatPath: string;
  private readonly healthyMaxAgeMs: number;
  private readonly degradedMaxAgeMs: number;
  private readonly requiredSources: readonly HeartbeatSource[];
  private readonly auditLog?: AuditLog;
  private readonly operatorLogger?: OperatorLogger;
  private readonly now: () => number;

  /** Per-source last-touch ms; null = never observed. */
  private lastTouches: Record<HeartbeatSource, number | null> = {
    "baileys-poll": null,
    "telegram-poll": null,
    "pi-ping": null,
  };

  /**
   * Last state we *emitted* a transition for. Initialized to 'healthy'
   * at construction: the daemon is by definition alive when it builds
   * the Heartbeat object, so boot-time touches that drive the gauge
   * through 'dead' → 'healthy' do NOT spam a `pi_heartbeat` event. The
   * first thing operators see is the first DEPARTURE from healthy after
   * the priming window.
   */
  private lastEmittedState: HeartbeatState = "healthy";

  /**
   * Has every required source reported at least once? Until this is
   * true, computeState will return 'dead' (because some required source
   * is null), and we MUST suppress the corresponding emission — that's
   * boot-time priming, not a real outage. Once every required source
   * has been touched at least once, the gauge is "armed" and ordinary
   * transition emission resumes.
   *
   * (Without this gate, the message loop would always emit one
   * `pi_stuck_suspected` followed by one `pi_heartbeat` while the
   * baileys / telegram / pi-ping touches each fired for the first time —
   * pure noise.)
   */
  private armed = false;

  /** Serialize file writes so two near-simultaneous touches don't race. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: HeartbeatOpts) {
    if (opts.healthyMaxAgeMs <= 0) {
      throw new Error("healthyMaxAgeMs must be > 0");
    }
    if (opts.degradedMaxAgeMs <= opts.healthyMaxAgeMs) {
      throw new Error(
        "degradedMaxAgeMs must be > healthyMaxAgeMs (degraded is a wider window than healthy)"
      );
    }
    const required = opts.requiredSources ?? ALL_SOURCES;
    if (required.length === 0) {
      throw new Error("requiredSources must include at least one source");
    }
    for (const s of required) {
      if (!ALL_SOURCES.includes(s)) {
        throw new Error(`unknown source in requiredSources: ${s}`);
      }
    }

    this.heartbeatPath = opts.heartbeatPath;
    this.healthyMaxAgeMs = opts.healthyMaxAgeMs;
    this.degradedMaxAgeMs = opts.degradedMaxAgeMs;
    this.requiredSources = required;
    this.auditLog = opts.auditLog;
    this.operatorLogger = opts.operatorLogger;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record that `source` is alive *right now*.
   *
   * Called from the inbound message loop AFTER a successful poll
   * (Baileys / Telegram) or a successful pi-mono ping — never from a
   * standalone `setInterval`. See PE Skeptic Round 2 #2 in the plan.
   *
   * If, after recording, every required source is within `healthyMaxAgeMs`,
   * the heartbeat file's mtime is bumped (atomic temp+rename) so the
   * dead-man cron sees a fresh timestamp. If any required source is
   * stale, the file is intentionally NOT touched — the dead-man switch's
   * own age check will then fire.
   *
   * Throws (rejects) for an unknown source name. Rationale: an unknown
   * source is a code bug at the call site (typo in literal or invalid
   * cast), not a runtime condition we can recover from. Surfacing it as
   * a rejected promise makes the bug visible in the message loop's error
   * path instead of silently parking a healthy gauge.
   */
  async touchAlive(opts: { source: HeartbeatSource }): Promise<void> {
    if (!ALL_SOURCES.includes(opts.source)) {
      throw new Error(`unknown heartbeat source: ${String(opts.source)}`);
    }

    const ts = this.now();
    this.lastTouches[opts.source] = ts;

    // Decide state AFTER recording the touch. Note we re-read state via
    // the same path getState() takes so behavior stays consistent.
    const newState = this.computeState(ts);

    if (newState === "healthy") {
      // Touch the file only when *every* required source is fresh. This
      // is the load-bearing guarantee for the dead-man switch.
      await this.writeHeartbeatFile(ts);
    }

    await this.maybeEmitTransition(newState);
  }

  /**
   * Read the current state without touching anything. Reads file mtime
   * AND in-memory timestamps; the more pessimistic of the two wins. (If
   * either says "old", we report old — never fool ourselves into a false
   * healthy by trusting only one signal.)
   */
  async getState(): Promise<HeartbeatState> {
    const snapshot = await this.snapshot();

    // Audit emission also runs here so a passive `/status` poll that
    // observes a state transition still emits the event — even if no
    // touchAlive call has happened in between.
    await this.maybeEmitTransition(snapshot.state);

    return snapshot.state;
  }

  /**
   * Detailed snapshot for `/status` and tests. Does not emit audit events
   * (so callers can poll without spamming the log).
   */
  async snapshot(): Promise<HeartbeatSnapshot> {
    const ts = this.now();
    const ages: Record<HeartbeatSource, number | null> = {
      "baileys-poll": this.ageOf("baileys-poll", ts),
      "telegram-poll": this.ageOf("telegram-poll", ts),
      "pi-ping": this.ageOf("pi-ping", ts),
    };

    let fileAgeMs: number | null = null;
    try {
      const st = await stat(this.heartbeatPath);
      fileAgeMs = Math.max(0, ts - st.mtimeMs);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }

    const inMemory = this.computeState(ts);
    const fileState = this.stateFromAge(fileAgeMs);
    const state = pickWorse(inMemory, fileState);

    return { state, ages, fileAgeMs };
  }

  /**
   * Reset all in-memory timestamps and clear the on-disk file. Tests use
   * this to put the gauge back into the "no observation yet" state. Not
   * called by production code.
   */
  async reset(): Promise<void> {
    this.lastTouches = {
      "baileys-poll": null,
      "telegram-poll": null,
      "pi-ping": null,
    };
    // Restore the construction-time baseline so post-reset boot-up is
    // also silent (mirrors the original constructor invariant).
    this.lastEmittedState = "healthy";
    this.armed = false;
    try {
      await unlink(this.heartbeatPath);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
  }

  // -- internal helpers -----------------------------------------------------

  private ageOf(source: HeartbeatSource, ts: number): number | null {
    const t = this.lastTouches[source];
    return t === null ? null : Math.max(0, ts - t);
  }

  /**
   * In-memory state derived from `lastTouches`. The freshest required
   * source determines the state — if any required source is stale beyond
   * the dead threshold, we are dead. If any is stale beyond the healthy
   * threshold, we are degraded. Otherwise healthy.
   */
  private computeState(ts: number): HeartbeatState {
    let oldestRequired: number | null = null; // null = never observed

    for (const source of this.requiredSources) {
      const t = this.lastTouches[source];
      if (t === null) {
        // A required source that has never reported is treated as
        // infinitely stale — fail safe.
        return "dead";
      }
      const age = ts - t;
      if (oldestRequired === null || age > oldestRequired) {
        oldestRequired = age;
      }
    }

    return this.stateFromAge(oldestRequired);
  }

  /** Map an age-in-ms (or null = unknown) to a state. */
  private stateFromAge(ageMs: number | null): HeartbeatState {
    if (ageMs === null) return "dead";
    if (ageMs <= this.healthyMaxAgeMs) return "healthy";
    if (ageMs <= this.degradedMaxAgeMs) return "degraded";
    return "dead";
  }

  /**
   * Write/touch the heartbeat file with `ts` as the mtime. Uses
   * temp+rename for atomicity so the dead-man cron, which only reads
   * mtime, never sees a half-written or transiently-missing file. After
   * rename, also calls `utimes` to set the mtime explicitly — the rename
   * normally inherits the temp file's mtime, but on filesystems with
   * second-resolution timestamps explicit utimes makes the test seams
   * deterministic.
   */
  private writeHeartbeatFile(ts: number): Promise<void> {
    const next = this.writeQueue.then(
      () => this.writeHeartbeatFileNow(ts),
      () => this.writeHeartbeatFileNow(ts)
    );
    // Don't poison the queue on failure — a transient EIO shouldn't
    // wedge the daemon.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async writeHeartbeatFileNow(ts: number): Promise<void> {
    await mkdir(dirname(this.heartbeatPath), { recursive: true });
    const tempPath = `${this.heartbeatPath}.${process.pid}.${ts}.tmp`;
    // Body is informational only — the dead-man cron reads MTIME, not
    // contents. Including the timestamp helps post-mortem.
    const body = `${new Date(ts).toISOString()}\n`;
    try {
      await writeFile(tempPath, body, "utf8");
      await rename(tempPath, this.heartbeatPath);
      // Set mtime explicitly so it reflects `ts` (not the wall clock at
      // rename time, which may differ under fake timers in tests).
      const seconds = ts / 1000;
      await utimes(this.heartbeatPath, seconds, seconds);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Emit a state-transition audit event when the snapshot disagrees with
   * the last emitted state. Baseline is 'healthy' (set at construction)
   * so the first thing operators ever see is a DEPARTURE from healthy.
   *
   * - healthy → degraded/dead: pi_stuck_suspected
   * - degraded/dead → healthy: pi_heartbeat
   * - degraded → dead OR dead → degraded: pi_stuck_suspected (still bad)
   *
   * Per-source ages on `pi_stuck_suspected` (FIX-B-1 #6): when emitting a
   * stuck event, include `extra.stale_source` (the oldest source name),
   * `extra.oldest_age_ms`, and per-source ages — so post-incident review
   * can immediately see which transport hung without correlating to
   * other observability streams.  We compute the snapshot here rather
   * than reusing computeState's intermediates because (a) the gauge is
   * called from both `touchAlive` (in-memory state only) and `getState`
   * (file + memory) and we want consistent diagnostics either way, and
   * (b) age values must be flat scalars per audit/schema.ts `extra`
   * constraints — we flatten to `age_ms_baileys_poll` etc.
   */
  private async maybeEmitTransition(state: HeartbeatState): Promise<void> {
    // Boot priming: until every required source has reported at least
    // once, suppress emission entirely. Once the first 'healthy' is
    // produced (which by definition means every required source has
    // touched at least once), arm the gauge for ordinary emission.
    if (!this.armed) {
      if (state === "healthy") {
        this.armed = true;
        this.lastEmittedState = "healthy";
      }
      return;
    }

    const prior = this.lastEmittedState;
    if (prior === state) return;

    this.lastEmittedState = state;

    if (state === "healthy") {
      this.operatorLogger?.info("pi_heartbeat", { from: prior, to: state });
      if (this.auditLog) {
        await this.auditLog
          .append({
            event: "pi_heartbeat",
            task_id: null,
            channel: "system",
            sender_id_hash: null,
            extra: { from: prior, to: state },
          })
          .catch(() => undefined);
      }
      return;
    }

    // Either degraded or dead — surface per-source ages so the audit row
    // names which transport is stale.  See class docstring above.
    const ts = this.now();
    const ages: Record<HeartbeatSource, number | null> = {
      "baileys-poll": this.ageOf("baileys-poll", ts),
      "telegram-poll": this.ageOf("telegram-poll", ts),
      "pi-ping": this.ageOf("pi-ping", ts),
    };
    const { staleSource, oldestAgeMs } = pickStaleSource(
      ages,
      this.requiredSources,
    );

    const extra: Record<string, string | number | boolean> = {
      from: prior,
      to: state,
    };
    if (staleSource !== null) extra.stale_source = staleSource;
    if (oldestAgeMs !== null) extra.oldest_age_ms = oldestAgeMs;
    // Flatten per-source ages into separate scalar fields.  The audit
    // schema's `extra` is restricted to scalars (no nested objects), so
    // we cannot pass the `ages` map directly.  We use the source name as
    // a key prefix with `_` substituted for the `-` so the field name is
    // a valid identifier shape.
    for (const [src, age] of Object.entries(ages) as [
      HeartbeatSource,
      number | null,
    ][]) {
      if (age !== null) extra[`age_ms_${src.replace(/-/g, "_")}`] = age;
    }

    this.operatorLogger?.info("pi_stuck_suspected", {
      from: prior,
      to: state,
      stale_source: staleSource ?? "unknown",
      oldest_age_ms: oldestAgeMs ?? -1,
    });
    if (this.auditLog) {
      await this.auditLog
        .append({
          event: "pi_stuck_suspected",
          task_id: null,
          channel: "system",
          sender_id_hash: null,
          extra,
        })
        .catch(() => undefined);
    }
  }
}

/**
 * Identify the staleest required source from the per-source ages map.
 * A `null` age (source never touched) is "infinitely stale" and wins
 * over any finite age.  Non-required sources are ignored even if older.
 *
 * Returns `{ staleSource: null, oldestAgeMs: null }` when no required
 * source has a finite age and no required source is null (which happens
 * only if the required-set is empty — defended against in the
 * constructor).
 */
function pickStaleSource(
  ages: Record<HeartbeatSource, number | null>,
  required: readonly HeartbeatSource[],
): { staleSource: HeartbeatSource | null; oldestAgeMs: number | null } {
  let staleSource: HeartbeatSource | null = null;
  let oldestAgeMs: number | null = null;
  for (const src of required) {
    const age = ages[src];
    if (age === null) {
      // A never-touched required source is the most-stale possible —
      // pick it and stop (no other source can beat "infinity").
      return { staleSource: src, oldestAgeMs: null };
    }
    if (oldestAgeMs === null || age > oldestAgeMs) {
      oldestAgeMs = age;
      staleSource = src;
    }
  }
  return { staleSource, oldestAgeMs };
}

/** Order: healthy < degraded < dead. The "worse" of two states wins. */
function pickWorse(a: HeartbeatState, b: HeartbeatState): HeartbeatState {
  const rank = { healthy: 0, degraded: 1, dead: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
