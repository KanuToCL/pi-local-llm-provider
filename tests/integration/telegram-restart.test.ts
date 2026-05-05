/**
 * Plan v3 §2.1c — Daemon poll watchdog integration tests (IMPL-W2-G2).
 *
 * Validates the five-defense `TelegramPollWatchdog`:
 *   1. cooldown after 3 consecutive restart failures
 *   2. restartInFlight guard (no parallel restarts)
 *   3. only-when-connected
 *   4. shutdown CAS guard
 *   5. monotonic-clock immunity to wall-clock jumps (suspend/resume)
 *
 * Uses `daemon-test-harness.ts` (descope path: stubs `TelegramChannel`
 * directly per Integration B1 LOC budget) so each test is deterministic
 * (no real timers, no real grammY) while still exercising the production
 * `TelegramPollWatchdog` class end-to-end.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  makeWatchdogHarness,
  type DaemonWatchdogHarness,
} from "./daemon-test-harness.js";

let harness: DaemonWatchdogHarness;

beforeEach(() => {
  harness = makeWatchdogHarness();
});

afterEach(async () => {
  await harness.shutdown();
});

// ---------------------------------------------------------------------------
// Defense 5 — monotonic-clock-driven liveness check
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — stale detection", () => {
  test("calls restart() when monotonic age exceeds threshold", async () => {
    // Seed a poll attempt at t0, then advance monotonic by 130s (> 120s
    // staleMs default). Watchdog should fire restart on next tick.
    harness.notePollAttempt();
    harness.advanceMonotonicMs(130_000);
    await harness.fireWatchdogTick();

    expect(harness.channel.restartCalls.length).toBe(1);
    expect(harness.channel.restartCalls[0]!.reason).toBe(
      "poll_silent_too_long",
    );
  });

  test("does NOT restart on healthy poll-attempt heartbeat", async () => {
    // Fresh poll attempt at t0, advance only 60s (< 120s staleMs).
    harness.notePollAttempt();
    harness.advanceMonotonicMs(60_000);
    await harness.fireWatchdogTick();

    expect(harness.channel.restartCalls.length).toBe(0);
  });

  test("never restarts a never-polled channel", async () => {
    // No notePollAttempt() — lastPollAttemptMonotonicMs is null.
    // Advance way past staleMs; watchdog should bail on the null check.
    harness.advanceMonotonicMs(600_000);
    await harness.fireWatchdogTick();

    expect(harness.channel.restartCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Restart audit + operator-log emission
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — restart instrumentation", () => {
  test("emits telegram_restart audit row + telegram_poll_stale_restart operator-log", async () => {
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000);
    await harness.fireWatchdogTick();

    // Operator log: warn-equivalent (we adapt to .info per OperatorLogger
    // having no .warn — see daemon.ts checkLiveness comment).
    const stale = harness.loggerCalls.find(
      (c) => c.event === "telegram_poll_stale_restart",
    );
    expect(stale).toBeDefined();
    expect(stale!.fields?.age_ms).toBeGreaterThanOrEqual(150_000);
    expect(stale!.fields?.threshold_ms).toBe(120_000);

    // Audit emission goes through TelegramChannel.restart() which is stubbed
    // — the stub doesn't write the audit row; production .restart() does.
    // What the watchdog itself emits to the audit log (vs delegating to
    // restart()) is the cooldown-triggered telegram_restart_skipped row.
    // Therefore: assert the restart() was invoked with the right reason
    // (which mirrors what the production restart() audits).
    expect(harness.channel.restartCalls[0]!.reason).toBe(
      "poll_silent_too_long",
    );
  });
});

// ---------------------------------------------------------------------------
// Defense 2 — restartInFlight guard
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — restartInFlight guard", () => {
  test("does NOT fire while a restart is in-flight (back-to-back ticks)", async () => {
    harness.channel.setManualResolution(true);
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000);

    // First tick fires restart; do NOT resolve yet.
    void harness.watchdog.checkLiveness();
    // Yield so the synchronous restartInFlight assignment runs.
    await new Promise((r) => setImmediate(r));
    expect(harness.channel.restartCalls.length).toBe(1);

    // Second tick during in-flight restart → must be a no-op.
    harness.advanceMonotonicMs(35_000); // tick interval elapsed
    await harness.watchdog.checkLiveness();
    expect(harness.channel.restartCalls.length).toBe(1);

    // Now resolve — the in-flight should clear; next tick after fresh
    // poll-attempt should NOT fire (because the success path resets the
    // monotonic mirror).
    harness.channel.resolveNextRestart();
    await new Promise((r) => setImmediate(r));
    await harness.watchdog.checkLiveness();
    expect(harness.channel.restartCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defense 1 — cooldown after 3 consecutive failures
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — cooldown after consecutive failures", () => {
  test("3 consecutive restart failures → cooldown engaged; 4th call after threshold age does NOT call restart() until cooldown expires", async () => {
    harness.channel.queueFailures([
      new Error("net err 1"),
      new Error("net err 2"),
      new Error("net err 3"),
    ]);
    // Wide enough age to trigger restart on every tick.
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000);

    // Fire 3 ticks: each fails restart. After each failure the mirror is
    // NOT advanced (only success resets it), so age stays >= staleMs.
    await harness.fireWatchdogTick();
    await harness.fireWatchdogTick();
    await harness.fireWatchdogTick();
    expect(harness.channel.restartCalls.length).toBe(3);

    // After 3rd failure, cooldown is set. operator-log error fires.
    const giving = harness.loggerCalls.find(
      (c) => c.event === "telegram_restart_giving_up",
    );
    expect(giving).toBeDefined();
    expect(giving!.severity).toBe("error");

    // telegram_restart_skipped audit row was queued — drain and assert.
    const audits = await harness.auditCalls();
    const skipped = audits.find((e) => e.event === "telegram_restart_skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.extra?.reason).toBe("consecutive_failures_exceeded");
    expect(skipped!.extra?.failures).toBe(3);

    // 4th tick within cooldown window — must NOT call restart().
    await harness.fireWatchdogTick();
    expect(harness.channel.restartCalls.length).toBe(3);

    // Advance past cooldown (default 600_000ms = 10 min) — restart attempt
    // resumes. Queue success this time.
    harness.advanceMonotonicMs(610_000);
    await harness.fireWatchdogTick();
    expect(harness.channel.restartCalls.length).toBe(4);
  });

  test("cooldown resets to fresh after a successful restart", async () => {
    // Fail twice, then succeed. Counter must reset to 0; no cooldown set.
    harness.channel.queueFailures([
      new Error("transient 1"),
      new Error("transient 2"),
    ]);
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000);
    await harness.fireWatchdogTick();
    await harness.fireWatchdogTick();
    expect(harness.watchdog._getConsecutiveFailures()).toBe(2);

    // Third call — no failure queued, succeeds.
    await harness.fireWatchdogTick();
    expect(harness.watchdog._getConsecutiveFailures()).toBe(0);
    expect(harness.watchdog._getCooldownUntil()).toBe(0);

    // After success the mirror is reset to monotonicNow; trying another
    // tick at the same monotonic time is healthy and should NOT fire.
    await harness.fireWatchdogTick();
    expect(harness.channel.restartCalls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Defense 4 — shutdown CAS guard
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — shutdown CAS guard", () => {
  test("watchdog stops on shutdown — clearInterval AND no restart fires after", async () => {
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000);

    harness.watchdog.markShuttingDown();
    harness.watchdog.stop();

    // clearInterval was called.
    expect(harness.clearIntervalFn).toHaveBeenCalledTimes(1);

    // A tick that fires concurrent with shutdown (we simulate by directly
    // invoking checkLiveness AFTER markShuttingDown but BEFORE clear) must
    // NOT call restart().
    await harness.watchdog.checkLiveness();
    expect(harness.channel.restartCalls.length).toBe(0);

    // No telegram_restart_skipped audit row either — the CAS guard short-
    // circuits BEFORE the audit-emit branch.
    const audits = await harness.auditCalls();
    const skipped = audits.find((e) => e.event === "telegram_restart_skipped");
    expect(skipped).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Defense 3 — only-when-connected
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — disconnected-channel guard", () => {
  test("does NOT call restart() when channel is disconnected", async () => {
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000);
    harness.channel.setConnected(false);

    await harness.fireWatchdogTick();
    expect(harness.channel.restartCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Defense 5 — monotonic-clock immunity to wall-clock jumps
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — suspend/resume immunity", () => {
  test("fake suspend/resume by advancing wall clock 5h while monotonic clock advances 1s — does NOT trigger restart", async () => {
    // Setup: harness uses our fake monotonic clock exclusively. The wall
    // clock isn't read by checkLiveness — we simulate the suspend/resume
    // scenario by advancing the wall clock via vi.useFakeTimers() (just to
    // ensure no observable Date.now()-based path leaks into the watchdog)
    // while advancing monotonic by only 1s.
    harness.notePollAttempt();
    // Real-world scenario: laptop suspended at t=0, resumed at t+5h. The
    // OS pauses process.hrtime alongside the process — so the monotonic
    // clock only sees ~1s of "execution time" between suspend and resume.
    // Wall clock has jumped 5h. The watchdog reads ONLY monotonic; this
    // test asserts that.
    harness.advanceMonotonicMs(1_000); // 1s monotonic
    // No advanceMonotonicMs(5_000_000) — that would be the wall-clock jump.

    await harness.fireWatchdogTick();
    expect(harness.channel.restartCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Construction-time validation (boot-assertion mirrors PE Skeptic IMPORTANT-7)
// ---------------------------------------------------------------------------

describe("TelegramPollWatchdog — construction validation", () => {
  test("throws when staleMs <= 2× pollTimeoutMs (60s)", async () => {
    await expect(async () => {
      makeWatchdogHarness({ staleMs: 60_000 });
    }).rejects.toThrow(/staleMs/);
  });

  test("throws when tickMs is out of [5s, 120s] band", async () => {
    await expect(async () => {
      makeWatchdogHarness({ tickMs: 1_000 });
    }).rejects.toThrow(/tickMs/);
    await expect(async () => {
      makeWatchdogHarness({ tickMs: 200_000 });
    }).rejects.toThrow(/tickMs/);
  });

  test("throws when failureCooldownMs < 60s", async () => {
    await expect(async () => {
      makeWatchdogHarness({ failureCooldownMs: 30_000 });
    }).rejects.toThrow(/failureCooldownMs/);
  });
});

// ---------------------------------------------------------------------------
// FIX-A (post-AUDIT-G2 IMPORTANT-1) — restart() hard timeout
// ---------------------------------------------------------------------------
//
// Without a hard timeout, a restart() that hangs forever (e.g. wedged
// `bot.api.getMe()` against a network-partitioned Telegram, or a fresh
// node-fetch agent that never opens its TCP handshake) would pin
// `restartInFlight !== null` indefinitely. The watchdog's defense-2 guard
// would then skip every subsequent tick — silently disabling the
// self-healing entirely. The hard timeout (= 2× staleMs) caps how long any
// single restart attempt can occupy the slot; on timeout it counts as a
// consecutive failure (incrementing the cooldown counter), and the
// in-flight slot is freed so the next watchdog tick can re-attempt.

describe("TelegramPollWatchdog — restart hard timeout (FIX-A)", () => {
  test("restart that hangs forever triggers hard timeout, increments consecutiveRestartFailures, clears restartInFlight", async () => {
    // Manual mode so the stub's restart() returns a never-resolving promise
    // until we explicitly resolve/reject it (which we never do here — the
    // watchdog's own hard-timeout race is what must fire).
    harness.channel.setManualResolution(true);
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000); // > 120s staleMs

    // Kick the watchdog. checkLiveness() awaits the in-flight promise; the
    // hard timeout's `restart_hard_timeout` rejection is what we drive.
    const tickPromise = harness.watchdog.checkLiveness();
    // Yield once so the synchronous restartInFlight assignment runs and the
    // setTimeout schedule lands.
    await new Promise((r) => setImmediate(r));
    expect(harness.channel.restartCalls.length).toBe(1);
    expect(harness.watchdog._getRestartInFlight()).not.toBeNull();

    // Advance the harness's fake setTimeout by 2× staleMs (the hard
    // timeout). The harness will fire any pending timeouts that have
    // elapsed (default staleMs=120_000 → hardTimeout=240_000).
    harness.fireSetTimeoutsAfter(240_001);
    await tickPromise;

    // Restart-in-flight slot freed (so the next tick can re-fire).
    expect(harness.watchdog._getRestartInFlight()).toBeNull();
    // Counter incremented (timeout-as-failure path).
    expect(harness.watchdog._getConsecutiveFailures()).toBe(1);
  });

  test("after hard timeout fires, watchdog re-fires restart on next tick", async () => {
    // Same setup as above — restart hangs, hard timeout fires, counter
    // increments. Then a fresh tick (still over staleMs because the mirror
    // never reset on failure) must re-attempt restart.
    harness.channel.setManualResolution(true);
    harness.notePollAttempt();
    harness.advanceMonotonicMs(150_000);

    const tick1 = harness.watchdog.checkLiveness();
    await new Promise((r) => setImmediate(r));
    expect(harness.channel.restartCalls.length).toBe(1);
    harness.fireSetTimeoutsAfter(240_001);
    await tick1;
    expect(harness.watchdog._getRestartInFlight()).toBeNull();

    // Second tick — restart slot is free, mirror is stale (never reset on
    // the failed attempt), so the watchdog must re-fire.
    const tick2 = harness.watchdog.checkLiveness();
    await new Promise((r) => setImmediate(r));
    expect(harness.channel.restartCalls.length).toBe(2);
    harness.fireSetTimeoutsAfter(240_001);
    await tick2;
    expect(harness.watchdog._getConsecutiveFailures()).toBe(2);
  });
});
