/**
 * Tests for `installPollAttemptTransformer` (Plan v3 §1.2a + §1.2e).
 *
 * The transformer wraps every `bot.api.<method>(...)` call. Per the F2 fix
 * (production hang 2026-05-04), it must fire the heartbeat callback after
 * a SUCCESSFUL `getUpdates` call regardless of whether the response carries
 * any updates — empty long-poll returns prove the bot is alive.
 *
 * Coverage (resolves Testing B1 / B2 / B3 / W1 from Ring of Elders v0.3):
 *
 *   1. fires onPollAttempt after successful getUpdates with 0 updates  <-- F2
 *   2. fires onPollAttempt after successful getUpdates with N>0 updates
 *   3. does NOT fire onPollAttempt when getUpdates throws (network error)
 *   4. does NOT fire when getUpdates returns ok:false (e.g., 401 token-revoked)
 *   5. does NOT fire for non-getUpdates methods (sendMessage, getMe, ...)
 *   6. callback that throws does NOT propagate (API call still resolves)
 *   7. prev() return value passes through unchanged regardless of callback
 *   8. transformer is composable — installing alongside another transformer
 *      preserves chain order (smoke check)
 *   9. defensive 2x-install guard (Symbol-based marker) — second install is a no-op
 *
 * Strategy: the transformer is `bot.api.config.use(...)` so we drive it by
 * registering a controlled `prev` IN FRONT of our transformer (the chain
 * runs LAST→FIRST when calling `bot.api.<method>`, so the last-installed
 * transformer wraps everything before it). Tests stub `prev` to return a
 * controlled `ApiResponse` (no real HTTP, no api.telegram.org).
 */

import { describe, expect, test, vi } from "vitest";
import { Bot } from "grammy";
import type { UserFromGetMe } from "@grammyjs/types";

import { installPollAttemptTransformer } from "../../src/channels/poll-attempt-transformer.js";

// Reusable fake botInfo so handleUpdate / api stubs don't try to network.
const FAKE_BOT_INFO: UserFromGetMe = {
  id: 999_111,
  is_bot: true,
  first_name: "pi-comms-test",
  username: "pi_comms_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  can_manage_bots: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

/**
 * Build a plain Bot, attach a controlled fake-`prev` transformer FIRST so it
 * intercepts what would be the real HTTP call, then install the
 * poll-attempt transformer ON TOP. grammY runs transformers
 * last-installed-wraps-first-installed, so the order is:
 *
 *   bot.api.<method>()  →  pollTransformer  →  fakePrevTransformer  →  raw
 *
 * The fake-`prev` resolves with whatever the test asks (success / failure
 * / ok:false). The poll transformer's `prev` is therefore the fake.
 */
function makeBotWithStub(
  stub: (method: string, payload: unknown) => Promise<unknown>,
): Bot {
  const bot = new Bot("fake-token");
  bot.botInfo = FAKE_BOT_INFO;
  // Fake the bottom of the chain: stop the real HTTP layer from being hit.
  bot.api.config.use(async (_prev, method, payload, _signal) => {
    // Whatever stub returns IS the API response.
    return (await stub(method, payload)) as never;
  });
  return bot;
}

describe("installPollAttemptTransformer — getUpdates heartbeat semantics", () => {
  test("fires onPollAttempt after successful getUpdates with 0 updates (F2 fix)", async () => {
    const onPoll = vi.fn();
    const bot = makeBotWithStub(async (method) => {
      if (method === "getUpdates") return { ok: true, result: [] };
      return { ok: true, result: {} };
    });
    installPollAttemptTransformer(bot, onPoll);

    await bot.api.getUpdates({ offset: 0, timeout: 30 });

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test("fires onPollAttempt after successful getUpdates with N>0 updates", async () => {
    const onPoll = vi.fn();
    const bot = makeBotWithStub(async (method) => {
      if (method === "getUpdates") {
        return {
          ok: true,
          result: [
            { update_id: 1, message: { message_id: 1, date: 0, text: "hi" } },
            { update_id: 2, message: { message_id: 2, date: 0, text: "yo" } },
          ],
        };
      }
      return { ok: true, result: {} };
    });
    installPollAttemptTransformer(bot, onPoll);

    await bot.api.getUpdates({ offset: 0, timeout: 30 });

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test("does NOT fire onPollAttempt when getUpdates throws (network error)", async () => {
    const onPoll = vi.fn();
    const bot = makeBotWithStub(async (method) => {
      if (method === "getUpdates") throw new Error("ECONNRESET");
      return { ok: true, result: {} };
    });
    installPollAttemptTransformer(bot, onPoll);

    await expect(
      bot.api.getUpdates({ offset: 0, timeout: 30 }),
    ).rejects.toThrow(/ECONNRESET/);

    expect(onPoll).not.toHaveBeenCalled();
  });

  test("does NOT fire onPollAttempt when getUpdates returns ok:false (e.g., 401 token-revoked)", async () => {
    const onPoll = vi.fn();
    const bot = makeBotWithStub(async (method) => {
      if (method === "getUpdates") {
        return { ok: false, error_code: 401, description: "Unauthorized" };
      }
      return { ok: true, result: {} };
    });
    installPollAttemptTransformer(bot, onPoll);

    // grammY's TransformableApi.use chain returns the raw response shape,
    // but Bot.api.getUpdates throws when ok:false (it converts to GrammyError).
    // Either way our transformer must NOT fire on the false-ok branch.
    await bot.api
      .getUpdates({ offset: 0, timeout: 30 })
      .catch(() => undefined);

    expect(onPoll).not.toHaveBeenCalled();
  });

  test("does NOT fire onPollAttempt for non-getUpdates methods (sendMessage)", async () => {
    const onPoll = vi.fn();
    const bot = makeBotWithStub(async () => {
      // Any non-getUpdates: success.
      return { ok: true, result: { message_id: 1 } };
    });
    installPollAttemptTransformer(bot, onPoll);

    await bot.api.sendMessage(12345, "hello");

    expect(onPoll).not.toHaveBeenCalled();
  });

  test("does NOT fire onPollAttempt for getMe", async () => {
    const onPoll = vi.fn();
    const bot = makeBotWithStub(async () => ({
      ok: true,
      result: FAKE_BOT_INFO,
    }));
    installPollAttemptTransformer(bot, onPoll);

    await bot.api.getMe();

    expect(onPoll).not.toHaveBeenCalled();
  });

  test("onPollAttempt callback throwing does NOT propagate — API call still resolves", async () => {
    const onPoll = vi.fn(() => {
      throw new Error("heartbeat-internal-bug");
    });
    const bot = makeBotWithStub(async () => ({ ok: true, result: [] }));
    installPollAttemptTransformer(bot, onPoll);

    // Despite the callback throwing, the resolved value should pass through
    // — heartbeat MUST be best-effort to never break the polling loop.
    await expect(
      bot.api.getUpdates({ offset: 0, timeout: 30 }),
    ).resolves.toBeDefined();

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test("prev() return value passes through unchanged when callback succeeds", async () => {
    const onPoll = vi.fn();
    const updates = [
      { update_id: 7, message: { message_id: 7, date: 0, text: "x" } },
    ];
    const bot = makeBotWithStub(async (method) => {
      if (method === "getUpdates") return { ok: true, result: updates };
      return { ok: true, result: {} };
    });
    installPollAttemptTransformer(bot, onPoll);

    const got = await bot.api.getUpdates({ offset: 0, timeout: 30 });

    // grammy unwraps `result` from the `ApiResponse` envelope before returning.
    expect(got).toEqual(updates);
  });

  test("composable — installing alongside another transformer preserves chain order", async () => {
    const onPoll = vi.fn();
    const observed: string[] = [];
    const bot = makeBotWithStub(async (method) => {
      observed.push(`stub:${method}`);
      if (method === "getUpdates") return { ok: true, result: [] };
      return { ok: true, result: {} };
    });
    // Install poll transformer FIRST, then another transformer that just
    // logs. grammY runs last-installed first, so the OBSERVER wraps the
    // poll transformer.
    installPollAttemptTransformer(bot, onPoll);
    bot.api.config.use(async (prev, method, payload, signal) => {
      observed.push(`observer:${method}`);
      return await prev(method, payload, signal);
    });

    await bot.api.getUpdates({ offset: 0, timeout: 30 });

    // Observer ran before stub (it's outermost); poll transformer fired its
    // callback in between (after stub's prev resolved).
    expect(observed).toEqual(["observer:getUpdates", "stub:getUpdates"]);
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test("defensive 2x-install guard — second install is a no-op (Adversarial CONCERN-3)", async () => {
    const onPoll = vi.fn();
    const bot = makeBotWithStub(async () => ({ ok: true, result: [] }));

    installPollAttemptTransformer(bot, onPoll);
    // Second call MUST be a silent no-op so a future refactor that
    // accidentally re-enters connect() after restart() doesn't double the
    // heartbeat fan-out.
    installPollAttemptTransformer(bot, onPoll);

    await bot.api.getUpdates({ offset: 0, timeout: 30 });

    // Without the guard, this would be 2.
    expect(onPoll).toHaveBeenCalledTimes(1);
  });
});
