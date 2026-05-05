/**
 * Install a grammY Transformer that fires `onPollAttempt` AFTER every
 * successful `bot.api.getUpdates(...)` call — regardless of update count.
 *
 * Rationale (Plan v3 §1.2a — F1+F2 root fix):
 *
 *   grammY's middleware-based `bot.use()` only fires when an update is
 *   delivered. Empty long-poll returns (the normal "no new messages in 30s"
 *   case) do not touch heartbeat — a healthy-but-quiet bot looks identical
 *   to a wedged bot from the daemon's perspective. This is the F2 false
 *   positive that bit production on 2026-05-04 (MIB-2026-05-05-1751).
 *
 *   The grammY Transformer is the official extension point for wrapping
 *   API calls (see `node_modules/grammy/out/core/client.d.ts:35`). It
 *   receives:
 *     - `prev`:    the next call in the transformer chain (delegate)
 *     - `method`:  the API method name (e.g., "getUpdates", "sendMessage")
 *     - `payload`: the arguments
 *     - `signal`:  optional AbortSignal
 *
 *   We delegate to `prev`, then conditionally fire `onPollAttempt` after a
 *   SUCCESSFUL "getUpdates" resolves. Errors (incl. 401/409 fatal, 429
 *   retry_after, network) propagate naturally to grammY's loop error
 *   handler — we do not fire heartbeat in those cases because a wedged
 *   bot's failure modes look exactly like that and we'd be lying to the
 *   daemon's watchdog.
 *
 *   ok:false responses (e.g., a revoked token returning 401 Unauthorized
 *   in the JSON envelope without throwing) MUST also not fire heartbeat —
 *   same reason. We check `result.ok` explicitly.
 *
 * Why this is correct vs v1's TelegramPoller / v2's Bot subclass:
 *
 *   - `prev(method, payload, signal)` IS grammY's normal API call — keeps
 *     `bot.start()`, `bot.stop()`, retry logic, AbortSignal threading,
 *     deleteWebhook, offset confirmation, 401/409 fatal rethrow, 429
 *     retry_after — 100% intact.
 *   - Empty `getUpdates` returns ARE `result.ok === true` with empty
 *     `result.result` — fires heartbeat. THIS IS THE F2 FIX.
 *   - No new failure modes, no re-implemented loop, no replaced offset
 *     tracking.
 *
 * Idempotency (Adversarial CONCERN-3, v3 narrow re-bless):
 *
 *   Calling this twice on the same Bot would otherwise install two
 *   transformers and double the heartbeat fan-out. We guard with a
 *   well-known Symbol so a future refactor that calls connect() after
 *   restart() — or any other accidental re-entry path — is a silent
 *   no-op rather than a behavior change.
 *
 *   Inside `TelegramChannel.restart()` we construct a FRESH Bot via the
 *   botFactory, so each Bot has exactly one transformer regardless. The
 *   guard is defense-in-depth, not load-bearing.
 *
 * Heartbeat callback contract:
 *
 *   - The callback is `() => void` — synchronous. The transformer does
 *     NOT await it. If the callback returns a Promise, it's discarded.
 *   - The callback MUST NEVER break the polling loop. Any thrown error
 *     is caught and silently swallowed inside the transformer. The
 *     wrapping API call still resolves with the original `prev` result.
 */

import type { Bot } from "grammy";

/**
 * Sentinel symbol marking that a Bot already has the poll-attempt
 * transformer installed. Re-using `Symbol.for(...)` so the marker is
 * shared across module-loader instances (some bundler quirks
 * produce >1 module instance) — safer than a module-local Symbol.
 */
const INSTALLED_MARKER = Symbol.for("pi-comms.pollAttemptTransformerInstalled");

export function installPollAttemptTransformer(
  bot: Bot,
  onPollAttempt: () => void,
): void {
  // Defensive 2x-install guard (Adversarial CONCERN-3).
  const botAny = bot as unknown as Record<symbol, true | undefined>;
  if (botAny[INSTALLED_MARKER]) return;
  botAny[INSTALLED_MARKER] = true;

  bot.api.config.use(async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method === "getUpdates" && result.ok) {
      try {
        onPollAttempt();
      } catch {
        // Heartbeat is best-effort — a thrown callback MUST NEVER break
        // the polling loop. The API call still resolves with `result`.
      }
    }
    return result;
  });
}
