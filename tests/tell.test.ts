import { describe, expect, test } from "vitest";
import {
  COOLDOWN_MAP_HARD_CAP,
  defineTellTool,
  normalizeForDedupHash,
  pruneCooldownMap,
} from "../src/tools/tell.js";
import type { ChannelEvent, Sink, ToolUrgency } from "../src/tools/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class CapturingSink implements Sink {
  events: ChannelEvent[] = [];
  shouldFail = false;
  async send(event: ChannelEvent): Promise<void> {
    if (this.shouldFail) throw new Error("sink down");
    this.events.push(event);
  }
}

/** Mutable clock so we can advance time deterministically. */
function makeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function callTell(
  tool: ReturnType<typeof defineTellTool>,
  args: { text: string; urgency: ToolUrgency },
): Promise<{
  sent: boolean;
  deliveredTo?: string[];
  reason?: "cooldown" | "rate_limit";
}> {
  return tool.execute(args as Record<string, unknown>) as Promise<{
    sent: boolean;
    deliveredTo?: string[];
    reason?: "cooldown" | "rate_limit";
  }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defineTellTool", () => {
  test("successful tell with single sink: delivers and returns sent=true", async () => {
    const term = new CapturingSink();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap: new Map(),
      now: clock.now,
    });

    const r = await callTell(tool, { text: "phase 1 done", urgency: "milestone" });

    expect(r.sent).toBe(true);
    expect(r.deliveredTo).toEqual(["terminal"]);
    expect(term.events).toHaveLength(1);
    expect(term.events[0]).toMatchObject({
      type: "tell",
      urgency: "milestone",
      text: "phase 1 done",
    });
  });

  test("successful tell with multiple sinks: fans out in parallel", async () => {
    const term = new CapturingSink();
    const wa = new CapturingSink();
    const tg = new CapturingSink();
    const tool = defineTellTool({
      sinks: { terminal: term, whatsapp: wa, telegram: tg },
      cooldownMap: new Map(),
      now: makeClock().now,
    });

    const r = await callTell(tool, { text: "blocked on Y", urgency: "blocked" });

    expect(r.sent).toBe(true);
    expect(new Set(r.deliveredTo)).toEqual(new Set(["terminal", "whatsapp", "telegram"]));
    expect(term.events).toHaveLength(1);
    expect(wa.events).toHaveLength(1);
    expect(tg.events).toHaveLength(1);
  });

  test("cooldown suppresses identical text within 30s window", async () => {
    const term = new CapturingSink();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap: new Map(),
      now: clock.now,
    });

    const a = await callTell(tool, { text: "checking tests", urgency: "info" });
    expect(a.sent).toBe(true);

    clock.advance(15_000); // half-window later
    const b = await callTell(tool, { text: "checking tests", urgency: "info" });
    expect(b.sent).toBe(false);
    expect(b.reason).toBe("cooldown");
    expect(term.events).toHaveLength(1); // 2nd was suppressed
  });

  test("cooldown does NOT suppress different text inside the same window", async () => {
    // Adversarial check: a naive eq-based dedup would let the agent vary the
    // text just enough to bypass.  Here we send genuinely different content
    // at urgency=blocked (no rate cap), so only the cooldown gate matters.
    const term = new CapturingSink();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap: new Map(),
      now: clock.now,
    });

    await callTell(tool, { text: "tests passing", urgency: "blocked" });
    clock.advance(1_000);
    const b = await callTell(tool, { text: "deploy starting", urgency: "blocked" });

    expect(b.sent).toBe(true);
    expect(term.events).toHaveLength(2);
  });

  test("cosmetic-variation IS suppressed: lowercase + whitespace + punctuation collapse to same hash", async () => {
    // Plan §"Pitfall #27": "Done!", "DONE", "  done. " all hash the same.
    expect(normalizeForDedupHash("Done!")).toBe(normalizeForDedupHash("DONE"));
    expect(normalizeForDedupHash("  done.  ")).toBe(normalizeForDedupHash("done"));
    expect(normalizeForDedupHash("checking the tests!"))
      .toBe(normalizeForDedupHash("Checking The Tests"));

    const term = new CapturingSink();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap: new Map(),
      now: clock.now,
    });

    const a = await callTell(tool, { text: "checking the tests!", urgency: "blocked" });
    expect(a.sent).toBe(true);

    clock.advance(5_000);
    const b = await callTell(tool, {
      text: "Checking The Tests.",
      urgency: "blocked",
    });

    // Despite different casing/punctuation, the normalized hash matches the
    // first call so the cooldown suppresses delivery.
    expect(b.sent).toBe(false);
    expect(b.reason).toBe("cooldown");
    expect(term.events).toHaveLength(1);
  });

  test("per-urgency rate cap fires for info/milestone but NOT blocked/done/question", async () => {
    const term = new CapturingSink();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap: new Map(),
      now: clock.now,
    });

    // info has a ~0.667/min cap — first call passes, second within the same
    // minute is rate-limited.  Use distinct text so cooldown isn't the gate.
    const a = await callTell(tool, { text: "alpha info", urgency: "info" });
    expect(a.sent).toBe(true);

    clock.advance(5_000);
    const b = await callTell(tool, { text: "bravo info", urgency: "info" });
    expect(b.sent).toBe(false);
    expect(b.reason).toBe("rate_limit");

    // blocked / done / question have NO rate cap — fire many in the same
    // minute and they all go through (cooldown still applies if text matches,
    // so vary the text).
    for (let i = 0; i < 5; i++) {
      clock.advance(1_000);
      const r = await callTell(tool, {
        text: `urgent #${i}`,
        urgency: "blocked",
      });
      expect(r.sent).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      clock.advance(1_000);
      const r = await callTell(tool, { text: `done #${i}`, urgency: "done" });
      expect(r.sent).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      clock.advance(1_000);
      const r = await callTell(tool, {
        text: `question #${i}`,
        urgency: "question",
      });
      expect(r.sent).toBe(true);
    }
  });

  test("returned shape on success vs cooldown vs rate_limit", async () => {
    const term = new CapturingSink();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap: new Map(),
      now: clock.now,
    });

    // success
    const a = await callTell(tool, { text: "first ping", urgency: "milestone" });
    expect(a).toEqual({ sent: true, deliveredTo: ["terminal"] });

    // cooldown (identical text within 30s)
    clock.advance(1_000);
    const b = await callTell(tool, { text: "first ping", urgency: "milestone" });
    expect(b).toEqual({ sent: false, reason: "cooldown" });

    // rate_limit (different text but milestone has the same low cap as info)
    clock.advance(1_000);
    const c = await callTell(tool, { text: "second ping", urgency: "milestone" });
    expect(c).toEqual({ sent: false, reason: "rate_limit" });
  });

  test("all sinks fail: returns sent=true with deliveredTo=[] (does not throw)", async () => {
    const term = new CapturingSink();
    term.shouldFail = true;
    const wa = new CapturingSink();
    wa.shouldFail = true;
    const tool = defineTellTool({
      sinks: { terminal: term, whatsapp: wa },
      cooldownMap: new Map(),
      now: makeClock().now,
    });

    const r = await callTell(tool, { text: "ack", urgency: "blocked" });
    // The fan-out swallowed the per-sink errors; the tool reports success
    // for the *attempt* with an empty deliveredTo.  This matches plan
    // §"Sinks SHOULD be best-effort"; the daemon's channel layer is
    // responsible for surfacing transport-down state via /status, not via
    // a tool-result rejection.
    expect(r.sent).toBe(true);
    expect(r.deliveredTo).toEqual([]);
  });
});

describe("normalizeForDedupHash", () => {
  test("strips punctuation and collapses whitespace + lowercases", () => {
    expect(normalizeForDedupHash("Hello, World!")).toBe("hello world");
    expect(normalizeForDedupHash("  multiple   spaces  ")).toBe("multiple spaces");
    expect(normalizeForDedupHash("a-b-c")).toBe("abc");
    // numbers preserved
    expect(normalizeForDedupHash("v1.2.3 release")).toBe("v123 release");
  });
});

// ---------------------------------------------------------------------------
// FIX-B-3 Wave 8 — bounded eviction (TTL + LRU) on cooldownMap
// ---------------------------------------------------------------------------

describe("cooldownMap bounded eviction (FIX-B-3 Wave 8)", () => {
  test("10K unique tells cap the map at COOLDOWN_MAP_HARD_CAP", async () => {
    const term = new CapturingSink();
    const cooldownMap = new Map<string, number>();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap,
      now: clock.now,
      // Use blocked urgency so per-urgency rate cap is Infinity (no throttle).
    });

    for (let i = 0; i < 10_000; i++) {
      // Use a unique text each time (so cooldown won't suppress).
      await callTell(tool, { text: `unique #${i}`, urgency: "blocked" });
      // Tiny clock advance so each entry has a distinct timestamp; keep
      // them all within 2*cooldownMs so TTL prune doesn't take them.
      clock.advance(1);
    }
    // After 10K inserts the map must be capped at COOLDOWN_MAP_HARD_CAP.
    expect(cooldownMap.size).toBeLessThanOrEqual(COOLDOWN_MAP_HARD_CAP);
    expect(cooldownMap.size).toBe(COOLDOWN_MAP_HARD_CAP);
  });

  test("entries past 2*cooldownMs are pruned (TTL eviction)", async () => {
    const term = new CapturingSink();
    const cooldownMap = new Map<string, number>();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap,
      cooldownMs: 30_000,
      now: clock.now,
    });

    // Plant 5 distinct stale entries.
    for (let i = 0; i < 5; i++) {
      await callTell(tool, { text: `stale #${i}`, urgency: "blocked" });
      clock.advance(1);
    }
    expect(cooldownMap.size).toBe(5);

    // Jump well past 2 * cooldownMs (60s).
    clock.advance(120_000);

    // A fresh tell triggers prune at the top of execute().
    await callTell(tool, { text: "fresh entry", urgency: "blocked" });

    // All 5 stale entries should be gone; only the fresh one remains.
    expect(cooldownMap.size).toBe(1);
    expect(cooldownMap.has(normalizeForDedupHash("fresh entry"))).toBe(true);
  });

  test("recent entries are retained (TTL prune does not take them)", async () => {
    const term = new CapturingSink();
    const cooldownMap = new Map<string, number>();
    const clock = makeClock();
    const tool = defineTellTool({
      sinks: { terminal: term },
      cooldownMap,
      cooldownMs: 30_000,
      now: clock.now,
    });

    // Plant 3 entries.
    await callTell(tool, { text: "alpha", urgency: "blocked" });
    clock.advance(1_000);
    await callTell(tool, { text: "bravo", urgency: "blocked" });
    clock.advance(1_000);
    await callTell(tool, { text: "charlie", urgency: "blocked" });

    expect(cooldownMap.size).toBe(3);

    // Advance just under 2*cooldownMs (=60s); entries are still in the
    // 'recent' window.
    clock.advance(50_000);
    await callTell(tool, { text: "delta", urgency: "blocked" });
    // All 4 should be retained — none is past 2*cooldownMs.
    expect(cooldownMap.size).toBe(4);
  });
});

describe("pruneCooldownMap (unit)", () => {
  test("TTL pass drops entries older than 2*cooldownMs", () => {
    const map = new Map<string, number>();
    map.set("old", 1_000);
    map.set("borderline", 50_000); // older than cooldownMs but within 2x
    map.set("fresh", 95_000);
    pruneCooldownMap(map, 100_000, 30_000);
    // ttlCutoff = 100_000 - 60_000 = 40_000
    expect(map.has("old")).toBe(false); // 1_000 < 40_000
    expect(map.has("borderline")).toBe(true); // 50_000 >= 40_000
    expect(map.has("fresh")).toBe(true);
  });

  test("LRU pass enforces the hard cap by dropping oldest", () => {
    const map = new Map<string, number>();
    // Fill 5 entries at the same recent timestamp so TTL doesn't catch them.
    for (let i = 0; i < 5; i++) {
      map.set(`k${i}`, 1_000);
    }
    pruneCooldownMap(map, 1_010, 30_000, 3); // hardCap = 3
    expect(map.size).toBe(3);
    // Oldest two (k0, k1) should be gone; k2/k3/k4 remain.
    expect(map.has("k0")).toBe(false);
    expect(map.has("k1")).toBe(false);
    expect(map.has("k2")).toBe(true);
    expect(map.has("k3")).toBe(true);
    expect(map.has("k4")).toBe(true);
  });
});
