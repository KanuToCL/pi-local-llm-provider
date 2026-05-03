/**
 * Smoke tests that the channels/base.ts canonical types + the re-export
 * shims in src/tools/types.ts and src/lib/envelope.ts all line up.
 *
 * These tests don't exercise the channel transports; they verify the
 * type-import graph compiles and existing callers can still reach the
 * canonical types via either path.
 */

import { describe, expect, test } from "vitest";

// Canonical home — channels/base.ts owns these.
import type {
  ChannelEvent as ChannelEventCanonical,
  ChannelId as ChannelIdCanonical,
  InboundMessage as InboundMessageCanonical,
  InboundProcessor,
  Sink as SinkCanonical,
  ToolUrgency as ToolUrgencyCanonical,
} from "../src/channels/base.js";

// Re-export shim for tool callers.
import type {
  ChannelEvent as ChannelEventShim,
  Sink as SinkShim,
  ToolUrgency as ToolUrgencyShim,
} from "../src/tools/types.js";

// Re-export shim for envelope callers.
import type { InboundMessage as InboundMessageShim } from "../src/lib/envelope.js";

// Runtime function should still be reachable from tools/types (sanity that
// the re-export edits didn't accidentally drop fanOut).
import { fanOut } from "../src/tools/types.js";

describe("channels/base.ts — canonical types", () => {
  test("ChannelId enum accepts terminal/whatsapp/telegram and rejects others", () => {
    const a: ChannelIdCanonical = "terminal";
    const b: ChannelIdCanonical = "whatsapp";
    const c: ChannelIdCanonical = "telegram";
    // @ts-expect-error — sms is not a valid channel
    const _bad: ChannelIdCanonical = "sms";
    expect([a, b, c]).toEqual(["terminal", "whatsapp", "telegram"]);
  });

  test("InboundMessage carries channel + sender + payload + ts", () => {
    const msg: InboundMessageCanonical = {
      type: "text",
      channel: "telegram",
      sender: { id: "12345", name: "Sergio" },
      payload: { text: "hi" },
      ts: 1_700_000_000_000,
    };
    expect(msg.channel).toBe("telegram");
    expect(msg.sender.id).toBe("12345");
  });

  test("ChannelEvent discriminator union covers W3 types", () => {
    const events: ChannelEventCanonical[] = [
      { type: "tell", urgency: "info", text: "x", ts: 1 },
      {
        type: "confirm_request",
        shortId: "ABCD",
        question: "?",
        rationale: "r",
        risk: "low",
        expiresAt: 2,
        ts: 1,
      },
      { type: "auto_promote_notice", firingNumber: 1, taskAgeSeconds: 30, ts: 1 },
      { type: "go_background_notice", userMessagePreview: "p", ts: 1 },
      { type: "reply", text: "answer", ts: 1 },
      { type: "task_completed", taskId: "t1", finalMessage: "ok", ts: 1 },
      { type: "system_notice", text: "boot", level: "info", ts: 1 },
    ];
    expect(events).toHaveLength(7);
  });

  test("Sink + InboundProcessor interfaces are implementable", async () => {
    const sink: SinkCanonical = {
      async send(_event) {
        return;
      },
    };
    const proc: InboundProcessor = {
      async processInbound(_msg) {
        return;
      },
    };
    await sink.send({ type: "reply", text: "x", ts: 0 });
    await proc.processInbound({
      type: "text",
      channel: "terminal",
      sender: { id: "0" },
      payload: { text: "x" },
      ts: 0,
    });
    expect(typeof sink.send).toBe("function");
    expect(typeof proc.processInbound).toBe("function");
  });
});

describe("re-export shims", () => {
  test("tools/types.ts Sink + ChannelEvent + ToolUrgency align with channels/base", () => {
    // If the re-exports diverged, these assignments would not type-check.
    const sink: SinkCanonical = {} as SinkShim;
    const event: ChannelEventCanonical = {} as ChannelEventShim;
    const urgency: ToolUrgencyCanonical = "info" satisfies ToolUrgencyShim;
    expect(sink).toBeDefined();
    expect(event).toBeDefined();
    expect(urgency).toBe("info");
  });

  test("lib/envelope.ts InboundMessage aligns with channels/base", () => {
    const msg: InboundMessageCanonical = {
      type: "text",
      channel: "terminal",
      sender: { id: "0" },
      payload: { text: "x" },
      ts: 0,
    } satisfies InboundMessageShim;
    expect(msg.channel).toBe("terminal");
  });

  test("fanOut runtime helper still reachable through tools/types re-export graph", async () => {
    const events: ChannelEventCanonical[] = [];
    const sink: SinkCanonical = {
      async send(e) {
        events.push(e);
      },
    };
    const result = await fanOut(
      { terminal: sink },
      { type: "reply", text: "ok", ts: 0 },
    );
    expect(result.deliveredTo).toEqual(["terminal"]);
    expect(events).toHaveLength(1);
  });
});
