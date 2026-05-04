/**
 * Mapper tests for src/lib/sdk-shim.ts — pi-mono AgentSessionEvent → ChannelEvent.
 *
 * BUG-2026-05-03 fix history: Mapper used to emit `tell urgency=done` for
 * `message_end`, which Telegram prefixed with `📱` on every conversational reply.
 * Plan v2 (Ring of Elders converged): emit `reply` instead, no prefix, AND pass
 * the text through `redactCredentialShapes` to close a pre-existing credential-
 * leak gap on the conversational path (Security Elder W1).
 */
import { describe, expect, test, vi } from "vitest";
import { mapAgentEventToChannelEvent } from "../src/lib/sdk-shim.js";

describe("mapAgentEventToChannelEvent — message_end → reply", () => {
  test("non-empty assistant text returns a reply event", () => {
    const out = mapAgentEventToChannelEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi there" }],
        },
      },
      { now: () => 1_700_000_000_000 },
    );
    expect(out).toEqual({
      type: "reply",
      text: "Hi there",
      ts: 1_700_000_000_000,
    });
  });

  test("string-typed content path", () => {
    const out = mapAgentEventToChannelEvent(
      { type: "message_end", message: { role: "assistant", content: "compact reply" } },
      { now: () => 1 },
    );
    expect(out).toEqual({ type: "reply", text: "compact reply", ts: 1 });
  });

  test("joins multiple text blocks and trims", () => {
    const out = mapAgentEventToChannelEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Hello " },
            { type: "thinking", thinking: "ignore" },
            { type: "text", text: "world  " },
          ],
        },
      },
      { now: () => 1 },
    );
    expect(out).toEqual({ type: "reply", text: "Hello world", ts: 1 });
  });

  test("returns null when only thinking blocks (no text)", () => {
    const out = mapAgentEventToChannelEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
      },
      { now: () => 1 },
    );
    expect(out).toBeNull();
  });

  test("returns null when text is whitespace-only; logs reason='empty_text'", () => {
    const debug = vi.fn();
    const out = mapAgentEventToChannelEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "   \n  " }] },
      },
      { now: () => 1, logger: { debug } },
    );
    expect(out).toBeNull();
    expect(debug).toHaveBeenCalledWith("framework_reply_dropped", { reason: "empty_text" });
  });

  test("returns null when message field undefined; logs reason='no_message'", () => {
    const debug = vi.fn();
    const out = mapAgentEventToChannelEvent(
      { type: "message_end" },
      { now: () => 1, logger: { debug } },
    );
    expect(out).toBeNull();
    expect(debug).toHaveBeenCalledWith("framework_reply_dropped", { reason: "no_message" });
  });

  test("rejects non-assistant role (defensive)", () => {
    const out = mapAgentEventToChannelEvent(
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "x" }] } },
      { now: () => 1 },
    );
    expect(out).toBeNull();
  });

  test("redacts credential shapes in the reply text (Security W1)", () => {
    const out = mapAgentEventToChannelEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "your key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA" },
          ],
        },
      },
      { now: () => 1 },
    );
    expect(out).not.toBeNull();
    expect((out as { text: string }).text).not.toContain("sk-ant-api03-");
    expect((out as { text: string }).text).toContain("[REDACTED:credential-shape]");
  });

  test("calls logger.debug with framework_reply_dropped on empty text", () => {
    const debug = vi.fn();
    mapAgentEventToChannelEvent(
      { type: "message_end", message: { role: "assistant", content: [] } },
      { now: () => 1, logger: { debug } },
    );
    expect(debug).toHaveBeenCalledWith("framework_reply_dropped", { reason: "empty_text" });
  });

  test("calls logger.debug with framework_reply_emitted on success", () => {
    const debug = vi.fn();
    mapAgentEventToChannelEvent(
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      { now: () => 1, logger: { debug } },
    );
    expect(debug).toHaveBeenCalledWith(
      "framework_reply_emitted",
      expect.objectContaining({ text_length: 2, redaction_applied: false }),
    );
  });
});

describe("mapAgentEventToChannelEvent — non-message_end events", () => {
  test("agent_end returns null (handled by subscriber side-effect)", () => {
    expect(mapAgentEventToChannelEvent({ type: "agent_end" })).toBeNull();
  });

  test("tool_execution_start returns null", () => {
    expect(mapAgentEventToChannelEvent({ type: "tool_execution_start" })).toBeNull();
  });

  test("non-object input returns null", () => {
    expect(mapAgentEventToChannelEvent(null)).toBeNull();
    expect(mapAgentEventToChannelEvent(undefined)).toBeNull();
    expect(mapAgentEventToChannelEvent("oops")).toBeNull();
  });
});
