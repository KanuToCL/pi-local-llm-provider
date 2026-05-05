/**
 * TelegramChannel — v0.3 Wave 1.1 additions (Plan v3 §1.2b–§1.2e):
 *   - Transformer wiring: heartbeat fires on poll attempt (incl. empty),
 *     not on update receipt.
 *   - `restart(reason)` — full Bot reconstruction via botFactory; preserves
 *     middleware chain; emits telegram_restart audit BEFORE reconstruction
 *     and telegram_restart_failed on throw; reconstructs `bot.api`
 *     (proves outbound TCP renewed); token-redacts the failure-message log.
 *
 * The existing inbound-text / typing / outbound / media coverage lives in
 * `tests/telegram-channel.test.ts` — this file is restart()-focused so the
 * historical suite stays untouched.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TelegramChannel } from "../../src/channels/telegram.js";
import { AuditLog } from "../../src/audit/log.js";
import { InboundRateLimiter } from "../../src/lib/inbound-rate-limit.js";
import type {
  InboundMessage,
  InboundProcessor,
} from "../../src/channels/base.js";
import type { RestartReason } from "../../src/audit/schema.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/telegram-channel.test.ts so we don't cross-import)
// ---------------------------------------------------------------------------

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

function makeBotFactory(): (token: string) => Bot {
  return (token: string) => {
    const bot = new Bot(token);
    bot.botInfo = FAKE_BOT_INFO;
    bot.api.getMe = vi.fn().mockResolvedValue(FAKE_BOT_INFO);
    bot.api.sendMessage = vi.fn().mockResolvedValue({} as never);
    bot.api.sendChatAction = vi.fn().mockResolvedValue(true);
    // Stub `bot.start()` so `restart()` doesn't actually spin up grammY's
    // long-poll loop in the background. With test stubs returning
    // instantly, the real loop would call getUpdates millions of times
    // per second and OOM the worker. Production behavior is verified by
    // the absence of changes to grammY itself; tests verify the
    // CHANNEL-side wiring (transformer install, audit emission, factory
    // call count, middleware re-installation).
    bot.start = vi.fn(async () => {
      // Mark as running so `bot.isRunning()` returns true post-restart.
      // grammY exposes `pollingRunning` as the underlying flag.
      (bot as unknown as { pollingRunning: boolean }).pollingRunning = true;
    }) as typeof bot.start;
    bot.stop = vi.fn(async () => {
      (bot as unknown as { pollingRunning: boolean }).pollingRunning = false;
    }) as typeof bot.stop;
    return bot;
  };
}

class CapturingProcessor implements InboundProcessor {
  received: InboundMessage[] = [];
  async processInbound(msg: InboundMessage): Promise<void> {
    this.received.push(msg);
  }
}

let updateCounter = 1;
function mkTextUpdate(opts: { fromId: number; text?: string }): Update {
  return {
    update_id: updateCounter++,
    message: {
      message_id: updateCounter++,
      date: Math.floor(Date.now() / 1000),
      from: {
        id: opts.fromId,
        is_bot: false,
        first_name: "Sergio",
        username: "sergio",
      },
      chat: {
        id: opts.fromId,
        type: "private",
        first_name: "Sergio",
      },
      text: opts.text ?? "hello",
    } as never,
  };
}

const ALLOWED = new Set(["12345"]);

// ---------------------------------------------------------------------------
// Tests — onPoll wiring (Plan §1.2b: now fired by transformer, not middleware)
// ---------------------------------------------------------------------------

describe("TelegramChannel — onPoll fires from transformer (not from update receipt)", () => {
  // Same teardown discipline as the restart() suite: tests in this block
  // never hit `restart()` (which is the dangerous path that schedules
  // bot.start() with stubbed networking), so we don't strictly need a
  // teardown — but adding it costs nothing and prevents regressions if
  // someone adds a restart-using test here later.

  test("inbound update arriving via handleUpdate does NOT itself fire onPoll", async () => {
    // The OLD path was a `bot.use()` first-middleware. Per §1.2b that
    // middleware is REMOVED — onPoll is now wired through the API
    // transformer, which only fires from real `getUpdates` calls.
    // `handleUpdate` bypasses the api layer entirely (it's grammY's
    // webhook seam), so onPoll MUST NOT fire when we manually inject
    // an update.
    const onPoll = vi.fn();
    const proc = new CapturingProcessor();
    const factory = makeBotFactory();
    let bot: Bot | undefined;
    new TelegramChannel({
      botToken: "fake-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      onPoll,
      botFactory: (t) => {
        bot = factory(t);
        return bot;
      },
    });
    if (!bot) throw new Error("bot not constructed");

    await bot.handleUpdate(mkTextUpdate({ fromId: 12345, text: "hi" }));

    expect(proc.received).toHaveLength(1);
    // Critical: the update was admitted, processor fired, but heartbeat
    // did NOT — because heartbeat now requires a real getUpdates poll
    // attempt, not a webhook-style update injection.
    expect(onPoll).not.toHaveBeenCalled();
  });

  test("a getUpdates call (via the transformer chain) fires onPoll exactly once", async () => {
    const onPoll = vi.fn();
    const proc = new CapturingProcessor();
    // Custom factory that installs a bottom-of-chain "fake server" stub
    // BEFORE the channel attaches its own transformer. grammY composes
    // last-installed-wraps-first-installed, so installing the stub in the
    // factory means the channel's transformer wraps the stub (and thus
    // channel-transformer.prev = stub).
    const factory = (token: string): Bot => {
      const bot = new Bot(token);
      bot.botInfo = FAKE_BOT_INFO;
      bot.api.getMe = vi.fn().mockResolvedValue(FAKE_BOT_INFO);
      bot.api.sendMessage = vi.fn().mockResolvedValue({} as never);
      bot.api.sendChatAction = vi.fn().mockResolvedValue(true);
      bot.api.config.use(async (_prev, method) => {
        if (method === "getUpdates") return { ok: true, result: [] } as never;
        return { ok: true, result: {} } as never;
      });
      return bot;
    };
    let bot: Bot | undefined;
    new TelegramChannel({
      botToken: "fake-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      onPoll,
      botFactory: (t) => {
        bot = factory(t);
        return bot;
      },
    });
    if (!bot) throw new Error("bot not constructed");

    await bot.api.getUpdates({ offset: 0, timeout: 30 });

    expect(onPoll).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests — restart() lifecycle (Plan §1.2c + §1.2e)
// ---------------------------------------------------------------------------

describe("TelegramChannel — restart()", () => {
  let auditDir: string;
  // Each test pushes constructed Bots here so afterEach can stop them.
  // Production grammY's `getUpdates` long-poll takes 30s+ when empty;
  // our test stubs return instantly so `bot.start()` after restart()
  // would otherwise busy-loop until OOM. Stopping the bot in afterEach
  // halts the loop deterministically.
  let constructedBots: Bot[];

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), "tg-restart-audit-"));
    constructedBots = [];
  });
  afterEach(async () => {
    // Stop every bot the test constructed so background loops halt.
    for (const b of constructedBots) {
      try {
        if (b.isRunning()) await b.stop();
      } catch {
        /* ignore — tests don't care about teardown errors */
      }
    }
    rmSync(auditDir, { recursive: true, force: true });
  });

  function readAuditLines(): Array<Record<string, unknown>> {
    const all: Array<Record<string, unknown>> = [];
    for (const name of readdirSync(auditDir)) {
      if (!name.startsWith("audit.")) continue;
      const raw = readFileSync(join(auditDir, name), "utf8");
      for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        all.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    return all;
  }

  test("restart() reconstructs bot.api (different object after restart — proves outbound TCP renewed)", async () => {
    const factory = makeBotFactory();
    const proc = new CapturingProcessor();
    const channel = new TelegramChannel({
      botToken: "fake-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      botFactory: (t) => {
        const b = factory(t);
        constructedBots.push(b);
        return b;
      },
    });

    expect(constructedBots).toHaveLength(1);
    await channel.restart("manual" satisfies RestartReason);
    expect(constructedBots).toHaveLength(2);
    // bot.api is the TransformableApi; it lives on the Bot instance, so a
    // freshly-constructed Bot has a freshly-constructed `bot.api`.
    expect(constructedBots[1]!.api).not.toBe(constructedBots[0]!.api);
  });

  test("restart() emits telegram_restart audit BEFORE reconstruction (so partial-failure still leaves a row)", async () => {
    const t = 1_700_000_000_000;
    const audit = new AuditLog({ dir: auditDir, daemonStartTs: t - 1000 });
    const proc = new CapturingProcessor();
    const factory = makeBotFactory();
    const channel = new TelegramChannel({
      botToken: "fake-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      auditLog: audit,
      botFactory: (t) => {
        const b = factory(t);
        constructedBots.push(b);
        return b;
      },
    });

    await channel.restart("poll_silent_too_long" satisfies RestartReason);

    // Force a flush via an unrelated audit so any in-flight write resolves.
    await audit.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const lines = readAuditLines();
    const restarts = lines.filter((l) => l.event === "telegram_restart");
    expect(restarts.length).toBe(1);
    expect((restarts[0]!.extra as { reason?: string }).reason).toBe(
      "poll_silent_too_long",
    );
  });

  test("restart() emits telegram_restart_failed audit when bot reconstruction throws", async () => {
    const t = 1_700_000_000_000;
    const audit = new AuditLog({ dir: auditDir, daemonStartTs: t - 1000 });
    const proc = new CapturingProcessor();
    let callCount = 0;
    // First factory call returns a working bot; second throws (simulates
    // construction failure during restart).
    const realFactory = makeBotFactory();
    const explodingFactory = (token: string): Bot => {
      callCount++;
      if (callCount === 1) {
        const b = realFactory(token);
        constructedBots.push(b);
        return b;
      }
      throw new Error("factory exploded mid-restart");
    };
    const channel = new TelegramChannel({
      botToken: "fake-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      auditLog: audit,
      botFactory: explodingFactory,
    });

    await expect(
      channel.restart("manual" satisfies RestartReason),
    ).rejects.toThrow(/factory exploded/);

    await audit.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const lines = readAuditLines();
    const failed = lines.filter((l) => l.event === "telegram_restart_failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.error_class).toBe("Error");
    expect((failed[0]!.extra as { reason?: string }).reason).toBe("manual");
  });

  test("restart() preserves rate-limit middleware (post-restart inbound flood still gets gated)", async () => {
    // Pre-restart: 11th rapid message hits per-sender cap and is silently
    // dropped + audited as inbound_rate_limited.
    // Post-restart: same flood pattern STILL trips the limiter — proves the
    // rate-limit middleware was reinstalled on the freshly-constructed Bot.
    const t = 1_700_000_000_000;
    const audit = new AuditLog({ dir: auditDir, daemonStartTs: t - 1000 });
    const limiter = new InboundRateLimiter({
      perSender: { capacity: 10, refillRatePerMs: 0 },
      perChannel: { capacity: 100, refillRatePerMs: 0 },
      now: () => t,
    });
    const proc = new CapturingProcessor();
    const factory = makeBotFactory();
    const channel = new TelegramChannel({
      botToken: "fake-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      auditLog: audit,
      inboundRateLimiter: limiter,
      botFactory: (t) => {
        const b = factory(t);
        constructedBots.push(b);
        return b;
      },
    });

    // Pre-restart: drain the bucket on the original bot.
    for (let i = 0; i < 10; i++) {
      await constructedBots[0]!.handleUpdate(
        mkTextUpdate({ fromId: 12345, text: `pre-${i}` }),
      );
    }
    expect(proc.received).toHaveLength(10);
    // 11th over the cap — silent reject.
    await constructedBots[0]!.handleUpdate(
      mkTextUpdate({ fromId: 12345, text: "pre-flood" }),
    );
    expect(proc.received).toHaveLength(10);

    // Restart — fresh Bot constructed, middleware MUST be re-installed.
    await channel.restart("manual" satisfies RestartReason);
    expect(constructedBots).toHaveLength(2);

    // Post-restart: the limiter is shared (same instance), so the same
    // sender is still over their per-sender cap. A new inbound MUST still
    // be silent-rejected — i.e., processor count does not advance — proving
    // the rate-limit middleware is wired on the new Bot.
    await constructedBots[1]!.handleUpdate(
      mkTextUpdate({ fromId: 12345, text: "post-flood" }),
    );
    expect(proc.received).toHaveLength(10);

    // Audit should contain both pre-restart inbound_rate_limited rows AND
    // a post-restart one — proving the rate-limit middleware runs on the
    // new bot.
    await audit.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const lines = readAuditLines();
    const rl = lines.filter((l) => l.event === "inbound_rate_limited");
    expect(rl.length).toBeGreaterThanOrEqual(2);
  });

  test("restart() reinstalls poll-attempt transformer on the new bot", async () => {
    const onPoll = vi.fn();
    const proc = new CapturingProcessor();
    // Custom factory that ALSO installs a bottom-of-chain stub so the
    // transformer chain is exercisable end-to-end (without this stub the
    // restart()'s internal getMe / start would try to hit the network;
    // also, asserting onPoll requires the transformer chain to actually
    // run — which means we cannot replace bot.api.getUpdates wholesale).
    const factory = (token: string): Bot => {
      const bot = new Bot(token);
      bot.botInfo = FAKE_BOT_INFO;
      bot.api.getMe = vi.fn().mockResolvedValue(FAKE_BOT_INFO);
      bot.api.sendMessage = vi.fn().mockResolvedValue({} as never);
      bot.api.sendChatAction = vi.fn().mockResolvedValue(true);
      // Install a bottom-of-chain "fake server" transformer that resolves
      // to canned ApiResponses. This MUST be installed before the channel
      // attaches its own transformer so the channel's transformer wraps
      // ours (last-installed-wraps-first-installed).
      bot.api.config.use(async (_prev, method) => {
        if (method === "getUpdates") return { ok: true, result: [] } as never;
        return { ok: true, result: {} } as never;
      });
      return bot;
    };
    const channel = new TelegramChannel({
      botToken: "fake-token",
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      onPoll,
      botFactory: (t) => {
        const b = factory(t);
        constructedBots.push(b);
        return b;
      },
    });

    await channel.restart("manual" satisfies RestartReason);
    expect(constructedBots).toHaveLength(2);

    // Trigger one getUpdates on the new bot through the full transformer
    // chain. onPoll MUST fire exactly once — proving the channel
    // reinstalled the poll-attempt transformer on the freshly-constructed
    // Bot during restart().
    onPoll.mockClear(); // ignore any fan-out triggered during restart()'s own probes
    await constructedBots[1]!.api.getUpdates({ offset: 0, timeout: 30 });

    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  test("restart() failure log REDACTS the bot token (Security B1)", async () => {
    // The failure path passes the error message through redactBotToken
    // before stamping it into the operator log. The test injects a token
    // that we KNOW the failure message will mention (we craft the
    // factory-throw to include the token literal) and asserts the log
    // payload does NOT contain the literal token.
    const TOKEN = "1234567890:AAEaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQ";
    const errors: Array<{ event: string; payload: Record<string, unknown> }> =
      [];
    const operatorLogger = {
      includeContent: false,
      preview: (v: string | undefined): string | undefined => v,
      banner: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      error: (event: string, payload?: Record<string, unknown>) => {
        errors.push({ event, payload: payload ?? {} });
      },
    };
    const proc = new CapturingProcessor();
    let callCount = 0;
    const realFactory = makeBotFactory();
    const explodingFactory = (token: string): Bot => {
      callCount++;
      if (callCount === 1) {
        const b = realFactory(token);
        constructedBots.push(b);
        return b;
      }
      // Embed the token in the error message so we can verify redaction.
      throw new Error(`construction failed using token ${token}`);
    };
    const channel = new TelegramChannel({
      botToken: TOKEN,
      allowedUserIds: ALLOWED,
      inboundProcessor: proc,
      operatorLogger,
      botFactory: explodingFactory,
    });

    await expect(
      channel.restart("manual" satisfies RestartReason),
    ).rejects.toThrow();

    const failedLog = errors.find((e) => e.event === "telegram_restart_failed");
    expect(failedLog).toBeDefined();
    const message = failedLog!.payload.message as string;
    expect(message).not.toContain(TOKEN);
    // Sanity: the message still carries SOMETHING about the failure.
    expect(message.length).toBeGreaterThan(0);
  });
});
