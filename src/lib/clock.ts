/**
 * Monotonic millisecond clock (Plan v3 §1.2c — Adversarial CONCERN-2).
 *
 * Returns elapsed milliseconds from an arbitrary process-relative origin.
 * Backed by `process.hrtime.bigint()` so it is:
 *   - Monotonic (never goes backwards even if wall-clock skews / NTP fixes).
 *   - Suspended-laptop safe (the OS pauses hrtime alongside the process,
 *     so resume-after-suspend doesn't surface a phantom multi-hour delta).
 *   - Independent of `Date.now()` — wall-clock-mock tests can't perturb it.
 *
 * Used by:
 *   - `TelegramChannel.restart()` for restart-latency observability
 *     (`telegram_restart_completed { latency_ms }`).
 *   - `Daemon` watchdog (IMPL-W2-G2) for poll-silence detection — the
 *     watchdog measures the time-since-last-poll-attempt against a
 *     stall threshold, and that math MUST NOT skew if the host suspends.
 *
 * Sharing this in `src/lib/` (rather than embedding it inside one channel)
 * avoids drift between the two consumers and matches the existing layout
 * convention (see `src/lib/heartbeat.ts`, `src/lib/rate-limit.ts`).
 */

export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
