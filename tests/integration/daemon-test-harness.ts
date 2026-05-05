/**
 * Daemon test harness — Plan v3 §2.1c (IMPL-W2-G2).
 *
 * The first integration harness in the repo (per Integration B1 sizing
 * guidance). Provides deterministic time + audit + restart-call control over
 * the `TelegramPollWatchdog` class without booting the full Daemon, since
 * the Daemon's `testMode` skips telegram entirely and the watchdog requires
 * a live channel.
 *
 * Per the plan's descope clause ("If implementer hits 500+ LOC, descope to
 * unit-level: mock `TelegramChannel.restart()` directly without booting full
 * Daemon"), this harness wires the `TelegramPollWatchdog` directly to a
 * stubbed channel + audit sink + monotonic-clock control, plus wraps a real
 * AuditLog over a temp directory so post-tick file inspection works.
 *
 * Helpers exposed to tests:
 *   - `harness.advanceMonotonicMs(N)` — bump the fake monotonic clock
 *   - `harness.fireWatchdogTick()` — manually invoke one liveness check pass
 *   - `harness.notePollAttempt()` — pretend grammY transformer just fired
 *   - `harness.simulateRestartFailure(throwOn?)` — make next restart() throw
 *   - `harness.simulateRestartSuccess()` — restart() resolves immediately
 *   - `harness.auditCalls()` — drain captured audit entries
 *   - `harness.shutdown()` — flip CAS guard + stop interval + cleanup tmp dir
 */

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { AuditLog } from "../../src/audit/log.js";
import type { AuditEntry } from "../../src/audit/schema.js";
import {
  TelegramPollWatchdog,
  type WatchdogHeartbeat,
  type WatchdogTelegramChannel,
} from "../../src/daemon.js";
import type { OperatorLogger, LogValue } from "../../src/utils/operator-logger.js";

// ---------------------------------------------------------------------------
// In-memory operator logger (assertable on .calls)
// ---------------------------------------------------------------------------

export interface CapturedLog {
  severity: "info" | "debug" | "error";
  event: string;
  fields?: Record<string, LogValue>;
}

function makeCapturedLogger(): { logger: OperatorLogger; calls: CapturedLog[] } {
  const calls: CapturedLog[] = [];
  const logger: OperatorLogger = {
    includeContent: false,
    preview: (v) => v,
    banner() {
      /* not used by watchdog */
    },
    info(event, fields) {
      calls.push({ severity: "info", event, fields });
    },
    debug(event, fields) {
      calls.push({ severity: "debug", event, fields });
    },
    error(event, fields) {
      calls.push({ severity: "error", event, fields });
    },
  };
  return { logger, calls };
}

// ---------------------------------------------------------------------------
// Stubbed Heartbeat — returns whatever ages the test pre-loaded
// ---------------------------------------------------------------------------

interface StubHeartbeatHandle extends WatchdogHeartbeat {
  setAges(ages: Record<string, number | null>): void;
  setSnapshotThrows(err: Error | null): void;
}

function makeStubHeartbeat(): StubHeartbeatHandle {
  let ages: Record<string, number | null> = {
    "pi-ping": 1_000,
    "telegram-poll": 1_000,
    "baileys-poll": null,
  };
  let throwsErr: Error | null = null;
  return {
    async snapshot() {
      if (throwsErr) throw throwsErr;
      return { state: "healthy", ages, fileAgeMs: 1_000 };
    },
    setAges(next) {
      ages = next;
    },
    setSnapshotThrows(err) {
      throwsErr = err;
    },
  };
}

// ---------------------------------------------------------------------------
// Stubbed TelegramChannel — captures restart() calls + lets tests control
// the resolution of each call
// ---------------------------------------------------------------------------

interface RestartCall {
  reason: "poll_silent_too_long" | "manual";
  resolved: boolean;
  errorThrown: Error | null;
}

interface StubChannelHandle extends WatchdogTelegramChannel {
  restartCalls: RestartCall[];
  setConnected(connected: boolean): void;
  /** Fail the NEXT N restart() calls (in order). Each `Error` from the array
   *  is thrown by exactly one restart(); after the array is drained, restart
   *  resolves successfully. */
  queueFailures(errs: Error[]): void;
  /** Detach restart() resolution — tests must call resolveNextRestart() or
   *  rejectNextRestart() explicitly. Useful for the `restartInFlight guard`
   *  test where two ticks fire while restart is pending. */
  setManualResolution(manual: boolean): void;
  /** Resolve the oldest-pending manual restart with success. */
  resolveNextRestart(): void;
  /** Reject the oldest-pending manual restart with the given error. */
  rejectNextRestart(err: Error): void;
}

function makeStubChannel(): StubChannelHandle {
  const restartCalls: RestartCall[] = [];
  let connected = true;
  const queuedFailures: Error[] = [];
  let manualMode = false;
  const pendingResolvers: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
    call: RestartCall;
  }> = [];

  const handle: StubChannelHandle = {
    restartCalls,
    isConnected: () => connected,
    async restart(reason) {
      const call: RestartCall = { reason, resolved: false, errorThrown: null };
      restartCalls.push(call);
      if (manualMode) {
        return new Promise<void>((resolve, reject) => {
          pendingResolvers.push({
            resolve: () => {
              call.resolved = true;
              resolve();
            },
            reject: (e) => {
              call.errorThrown = e;
              reject(e);
            },
            call,
          });
        });
      }
      const queued = queuedFailures.shift();
      if (queued) {
        call.errorThrown = queued;
        throw queued;
      }
      call.resolved = true;
    },
    setConnected(c) {
      connected = c;
    },
    queueFailures(errs) {
      queuedFailures.push(...errs);
    },
    setManualResolution(m) {
      manualMode = m;
    },
    resolveNextRestart() {
      const next = pendingResolvers.shift();
      if (!next) throw new Error("resolveNextRestart: no pending restart");
      next.resolve();
    },
    rejectNextRestart(err) {
      const next = pendingResolvers.shift();
      if (!next) throw new Error("rejectNextRestart: no pending restart");
      next.reject(err);
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface DaemonWatchdogHarness {
  watchdog: TelegramPollWatchdog;
  channel: StubChannelHandle;
  heartbeat: StubHeartbeatHandle;
  logger: OperatorLogger;
  /** All operator-log lines written through the captured logger. */
  loggerCalls: CapturedLog[];
  /** All audit entries captured (parsed from the temp jsonl). */
  auditCalls(): Promise<AuditEntry[]>;
  /** vi.fn that wraps setInterval — `.mock.calls` gives the scheduled handler. */
  setIntervalFn: ReturnType<typeof vi.fn>;
  clearIntervalFn: ReturnType<typeof vi.fn>;
  /** Bump the fake monotonic clock by the given delta. */
  advanceMonotonicMs(delta: number): void;
  /** Read the current fake monotonic time. */
  monotonicNow(): number;
  /** Tell the watchdog its monotonic mirror should reflect "fresh poll just
   *  happened right now" (uses current fake monotonic time). */
  notePollAttempt(): void;
  /** Manually invoke the watchdog's setInterval handler ONE time. Awaits the
   *  full liveness-check pass + any restart promise it kicks off (if no
   *  manual-resolution mode is active). */
  fireWatchdogTick(): Promise<void>;
  /** Fire all pending fake setTimeouts whose delay <= the given threshold
   *  (in fake-ms). Used by FIX-A tests to drive the restart hard-timeout
   *  race deterministically without real wall-clock waits. */
  fireSetTimeoutsAfter(thresholdMs: number): void;
  /** Tear down: flip CAS guard, stop interval, remove the temp audit dir. */
  shutdown(): Promise<void>;
}

export interface MakeHarnessOpts {
  /** Override watchdog tick interval. Default 30s. */
  tickMs?: number;
  /** Override stale threshold. Default 120s. */
  staleMs?: number;
  /** Override failure cooldown. Default 10min. */
  failureCooldownMs?: number;
  /** Pre-seed the monotonic clock. Default 1_000_000 (avoids zero-anchoring
   *  artifacts in tests that subtract from "earlier" timestamps). */
  initialMonotonicMs?: number;
}

export function makeWatchdogHarness(
  opts: MakeHarnessOpts = {},
): DaemonWatchdogHarness {
  const tickMs = opts.tickMs ?? 30_000;
  const staleMs = opts.staleMs ?? 120_000;
  const failureCooldownMs = opts.failureCooldownMs ?? 600_000;

  // Real AuditLog over a temp directory so we can later read the JSONL files
  // and assert the watchdog's `telegram_restart_skipped` rows landed.
  const tmpDir = mkdtempSync(join(tmpdir(), "watchdog-harness-"));
  const auditDir = join(tmpDir, "audit");
  const auditLog = new AuditLog({
    dir: auditDir,
    daemonStartTs: Date.now(),
    retentionDays: 90,
  });

  const { logger, calls: loggerCalls } = makeCapturedLogger();
  const channel = makeStubChannel();
  const heartbeat = makeStubHeartbeat();

  // Captured setInterval/clearInterval — we never actually let setInterval
  // schedule anything; tests drive ticks via `fireWatchdogTick()`.
  let scheduledHandler: (() => void) | null = null;
  const setIntervalFn = vi.fn((handler: () => void, _ms: number) => {
    scheduledHandler = handler;
    return Symbol("watchdog-interval-handle");
  });
  const clearIntervalFn = vi.fn((_handle: unknown) => {
    scheduledHandler = null;
  });

  // Fake setTimeout pool — captures pending timeouts queued by the watchdog's
  // hard-timeout race (FIX-A). Each entry records the scheduled handler +
  // its delay; tests use `fireSetTimeoutsAfter(thresholdMs)` to drain those
  // whose delay is below the threshold.  We avoid `vi.useFakeTimers()` so
  // the surrounding microtask queue (`setImmediate`, awaited promises)
  // behaves naturally — only the watchdog's setTimeout is intercepted.
  interface PendingTimeout {
    handler: () => void;
    delay: number;
    cancelled: boolean;
  }
  const pendingTimeouts: PendingTimeout[] = [];
  const setTimeoutFn = (handler: () => void, ms: number): unknown => {
    const t: PendingTimeout = { handler, delay: ms, cancelled: false };
    pendingTimeouts.push(t);
    // Mimic Node.js Timeout shape with .unref() so the watchdog's
    // `t.unref?.()` call doesn't crash.
    return { _harness: t, unref: () => undefined };
  };
  const clearTimeoutFn = (handle: unknown): void => {
    const inner = (handle as { _harness?: PendingTimeout })?._harness;
    if (inner) inner.cancelled = true;
  };

  // Fake monotonic clock — injectable via watchdog opts.
  let monotonicNow = opts.initialMonotonicMs ?? 1_000_000;
  const monotonicMsFn = () => monotonicNow;

  const watchdog = new TelegramPollWatchdog({
    telegramChannel: channel,
    auditLog,
    operatorLogger: logger,
    heartbeat,
    tickMs,
    staleMs,
    failureCooldownMs,
    setIntervalFn,
    clearIntervalFn,
    setTimeoutFn,
    clearTimeoutFn,
    monotonicMsFn,
  });
  watchdog.start();

  async function readAuditEntries(): Promise<AuditEntry[]> {
    if (!existsSync(auditDir)) return [];
    const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    const out: AuditEntry[] = [];
    for (const f of files) {
      const raw = readFileSync(join(auditDir, f), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as AuditEntry);
        } catch {
          /* skip malformed */
        }
      }
    }
    return out;
  }

  const harness: DaemonWatchdogHarness = {
    watchdog,
    channel,
    heartbeat,
    logger,
    loggerCalls,
    setIntervalFn,
    clearIntervalFn,
    monotonicNow: () => monotonicNow,
    advanceMonotonicMs(delta) {
      monotonicNow += delta;
    },
    notePollAttempt() {
      watchdog.notePollAttempt();
    },
    async fireWatchdogTick() {
      if (!scheduledHandler) {
        throw new Error(
          "fireWatchdogTick: no handler scheduled (was setIntervalFn invoked?)",
        );
      }
      // Run the handler. The setInterval callback wraps `checkLiveness().catch`;
      // we'd rather invoke checkLiveness directly so the test can `await` the
      // restart-promise side effects (audit appends, fail counter bumps).
      await watchdog.checkLiveness();
    },
    fireSetTimeoutsAfter(thresholdMs) {
      // Fire (and remove) every queued, non-cancelled timeout whose delay
      // is <= thresholdMs.  Does NOT advance any clock — just simulates
      // "enough wall-time has elapsed for these timers to elapse".  The
      // watchdog's hard-timeout race only relies on the timer firing, not
      // on `monotonicMs()` agreeing — so we don't need to bump that here.
      const toFire = pendingTimeouts.filter(
        (t) => !t.cancelled && t.delay <= thresholdMs,
      );
      for (const t of toFire) {
        t.cancelled = true; // mark fired so we don't double-fire
        try {
          t.handler();
        } catch {
          /* swallow — production has its own error handling */
        }
      }
    },
    async auditCalls() {
      // Audit appends are queued through AuditLog's internal serialization
      // queue (enqueueWrite). The watchdog's cooldown branch uses
      // `void this.auditLog.append(...)` so the caller MUST drain the
      // queue before reading. Easiest robust drain: chain our own append
      // (no-op marker the test ignores) — `await`'ing it forces FIFO
      // flush of every prior pending write.
      await auditLog
        .append({
          event: "audit_log_corruption_detected", // benign sentinel
          task_id: null,
          channel: "system",
          sender_id_hash: null,
          extra: { _harness_drain: true },
        })
        .catch(() => undefined);
      return readAuditEntries().then((entries) =>
        // Filter out our drain marker so callers don't see it.
        entries.filter((e) => e.extra?._harness_drain !== true),
      );
    },
    async shutdown() {
      watchdog.markShuttingDown();
      watchdog.stop();
      // Drain any pending audit appends before nuking the dir.
      await new Promise((r) => setImmediate(r));
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
  return harness;
}
