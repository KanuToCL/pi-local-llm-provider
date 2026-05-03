/**
 * Tests for `src/lib/session-ack-tracker.ts` (RS-6 session-boundary
 * detection per plan v4.2 §"Session boundary precisely defined").
 *
 * Coverage targets — one test per rule, plus combined and lifecycle:
 *   1. Default (no terminal-ack ever) → requiresTerminalAck = true (rule a, b)
 *   2. Rule (a): >24h since last terminal-ack → fires "ttl_expired"
 *   3. Rule (a): within 24h → does NOT fire ttl_expired (assuming other rules
 *      cleared)
 *   4. Rule (b): daemon restarted since last terminal-ack → fires
 *      "daemon_restart"
 *   5. Rule (b): same daemon as last ack → does NOT fire daemon_restart
 *   6. Rule (c): lock cycle since last ack → fires "lock_cycle"
 *   7. Rule (d): alive miss since last ack → fires "alive_miss"
 *   8. Rule (e): tool-derived flagged for taskId → fires "tool_derived"
 *      only for that task
 *   9. recordTerminalAck() clears all rules (a)-(e)
 *  10. Persistence: state survives a fresh tracker instance (load)
 *  11. Combined firing: multiple rules listed simultaneously
 *  12. snapshot() returns the state shape
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonStore } from "../src/storage/json-store.js";
import {
  SessionAckTracker,
  type SessionAckPersistedState,
} from "../src/lib/session-ack-tracker.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-session-ack-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface Harness {
  tracker: SessionAckTracker;
  store: JsonStore<SessionAckPersistedState>;
  setNow: (ms: number) => void;
  daemonStartTs: number;
}

async function makeTracker(opts?: {
  daemonStartTs?: number;
  ackTtlMs?: number;
  initialNow?: number;
}): Promise<Harness> {
  const store = new JsonStore<SessionAckPersistedState>(
    join(workDir, "session-ack.json"),
  );
  let nowMs = opts?.initialNow ?? 1_700_000_000_000;
  const tracker = new SessionAckTracker({
    jsonStore: store,
    daemonStartTs: opts?.daemonStartTs ?? 1_700_000_000_000,
    ackTtlMs: opts?.ackTtlMs,
    now: () => nowMs,
  });
  await tracker.load();
  return {
    tracker,
    store,
    setNow: (ms) => {
      nowMs = ms;
    },
    daemonStartTs: opts?.daemonStartTs ?? 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

describe("SessionAckTracker — defaults", () => {
  test("fresh tracker (never acked) requires terminal ack — rules (a) and (b) fire", async () => {
    const h = await makeTracker();
    expect(h.tracker.requiresTerminalAck()).toBe(true);
    const fires = h.tracker.firingRules();
    expect(fires).toContain("ttl_expired");
    expect(fires).toContain("daemon_restart");
  });
});

// ---------------------------------------------------------------------------
// Rule (a) — TTL
// ---------------------------------------------------------------------------

describe("SessionAckTracker — rule (a) ttl_expired", () => {
  test("ack within 24h does NOT fire ttl_expired", async () => {
    const h = await makeTracker({ ackTtlMs: 24 * 60 * 60 * 1000 });
    h.setNow(1_700_000_000_000);
    h.tracker.recordTerminalAck();

    h.setNow(1_700_000_000_000 + 60_000); // +1 min
    const fires = h.tracker.firingRules();
    expect(fires).not.toContain("ttl_expired");
  });

  test("ack older than 24h fires ttl_expired", async () => {
    const h = await makeTracker({ ackTtlMs: 24 * 60 * 60 * 1000 });
    h.setNow(1_700_000_000_000);
    h.tracker.recordTerminalAck();

    h.setNow(1_700_000_000_000 + 25 * 60 * 60 * 1000); // +25h
    const fires = h.tracker.firingRules();
    expect(fires).toContain("ttl_expired");
  });
});

// ---------------------------------------------------------------------------
// Rule (b) — daemon restart
// ---------------------------------------------------------------------------

describe("SessionAckTracker — rule (b) daemon_restart", () => {
  test("same daemon (no restart since ack) does NOT fire daemon_restart", async () => {
    const h = await makeTracker();
    h.tracker.recordTerminalAck();
    expect(h.tracker.firingRules()).not.toContain("daemon_restart");
  });

  test("daemon restart since ack fires daemon_restart", async () => {
    // First daemon: ack on disk.
    const store = new JsonStore<SessionAckPersistedState>(
      join(workDir, "session-ack.json"),
    );
    let nowMs = 1_700_000_000_000;
    const t1 = new SessionAckTracker({
      jsonStore: store,
      daemonStartTs: 1_700_000_000_000,
      now: () => nowMs,
    });
    await t1.load();
    t1.recordTerminalAck();
    await t1.flush();

    // New daemon (different start ts) loads same state.
    const t2 = new SessionAckTracker({
      jsonStore: store,
      daemonStartTs: 1_700_000_500_000, // +500s = restart
      now: () => nowMs + 1_000,
    });
    await t2.load();
    expect(t2.firingRules()).toContain("daemon_restart");
  });
});

// ---------------------------------------------------------------------------
// Rule (c) — lock cycle
// ---------------------------------------------------------------------------

describe("SessionAckTracker — rule (c) lock_cycle", () => {
  test("recordLockCycle() makes lock_cycle fire", async () => {
    const h = await makeTracker();
    h.tracker.recordTerminalAck();
    expect(h.tracker.firingRules()).not.toContain("lock_cycle");

    h.tracker.recordLockCycle();
    expect(h.tracker.firingRules()).toContain("lock_cycle");
  });

  test("recordTerminalAck() clears lock_cycle", async () => {
    const h = await makeTracker();
    h.tracker.recordLockCycle();
    expect(h.tracker.firingRules()).toContain("lock_cycle");

    h.tracker.recordTerminalAck();
    expect(h.tracker.firingRules()).not.toContain("lock_cycle");
  });
});

// ---------------------------------------------------------------------------
// Rule (d) — alive miss
// ---------------------------------------------------------------------------

describe("SessionAckTracker — rule (d) alive_miss", () => {
  test("recordAliveMiss() makes alive_miss fire", async () => {
    const h = await makeTracker();
    h.tracker.recordTerminalAck();
    expect(h.tracker.firingRules()).not.toContain("alive_miss");

    h.tracker.recordAliveMiss();
    expect(h.tracker.firingRules()).toContain("alive_miss");
  });

  test("recordTerminalAck() clears alive_miss", async () => {
    const h = await makeTracker();
    h.tracker.recordAliveMiss();
    expect(h.tracker.firingRules()).toContain("alive_miss");

    h.tracker.recordTerminalAck();
    expect(h.tracker.firingRules()).not.toContain("alive_miss");
  });
});

// ---------------------------------------------------------------------------
// Rule (e) — tool-derived
// ---------------------------------------------------------------------------

describe("SessionAckTracker — rule (e) tool_derived", () => {
  test("flagToolDerived(taskId) fires only for that task", async () => {
    const h = await makeTracker();
    h.tracker.recordTerminalAck();
    expect(h.tracker.firingRules({ taskId: "T-1" })).not.toContain(
      "tool_derived",
    );

    h.tracker.flagToolDerived("T-1");
    expect(h.tracker.firingRules({ taskId: "T-1" })).toContain("tool_derived");
    expect(h.tracker.firingRules({ taskId: "T-2" })).not.toContain(
      "tool_derived",
    );
    expect(h.tracker.firingRules()).not.toContain("tool_derived");
  });

  test("recordTerminalAck() clears every tool-derived flag", async () => {
    const h = await makeTracker();
    h.tracker.flagToolDerived("T-1");
    h.tracker.flagToolDerived("T-2");
    h.tracker.recordTerminalAck();

    expect(h.tracker.firingRules({ taskId: "T-1" })).not.toContain(
      "tool_derived",
    );
    expect(h.tracker.firingRules({ taskId: "T-2" })).not.toContain(
      "tool_derived",
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence + lifecycle
// ---------------------------------------------------------------------------

describe("SessionAckTracker — persistence", () => {
  test("state survives a fresh tracker instance (load)", async () => {
    const store = new JsonStore<SessionAckPersistedState>(
      join(workDir, "session-ack.json"),
    );
    let nowMs = 1_700_000_000_000;
    const t1 = new SessionAckTracker({
      jsonStore: store,
      daemonStartTs: 1_700_000_000_000,
      now: () => nowMs,
    });
    await t1.load();
    t1.recordTerminalAck();
    t1.recordLockCycle();
    await t1.flush();

    // Same daemon start ts: rule (b) shouldn't fire either; tracker should
    // remember the lock cycle.
    const t2 = new SessionAckTracker({
      jsonStore: store,
      daemonStartTs: 1_700_000_000_000,
      now: () => nowMs + 1_000,
    });
    await t2.load();
    expect(t2.firingRules()).toContain("lock_cycle");
    expect(t2.firingRules()).not.toContain("daemon_restart");
  });
});

// ---------------------------------------------------------------------------
// Combined + snapshot
// ---------------------------------------------------------------------------

describe("SessionAckTracker — combined firing + snapshot", () => {
  test("multiple rules can fire simultaneously", async () => {
    const h = await makeTracker({ ackTtlMs: 60_000 });
    h.setNow(1_700_000_000_000);
    h.tracker.recordTerminalAck();

    h.setNow(1_700_000_000_000 + 120_000); // ttl exceeded
    h.tracker.recordLockCycle();
    h.tracker.recordAliveMiss();
    h.tracker.flagToolDerived("T-X");

    const fires = h.tracker.firingRules({ taskId: "T-X" });
    expect(fires).toContain("ttl_expired");
    expect(fires).toContain("lock_cycle");
    expect(fires).toContain("alive_miss");
    expect(fires).toContain("tool_derived");
  });

  test("snapshot() returns state shape and toolDerived list", async () => {
    const h = await makeTracker();
    h.tracker.recordTerminalAck();
    h.tracker.flagToolDerived("T-A");
    h.tracker.flagToolDerived("T-B");

    const snap = h.tracker.snapshot();
    expect(snap.daemonStartTs).toBe(h.daemonStartTs);
    expect(snap.state.lastTerminalAckTs).not.toBeNull();
    expect(snap.toolDerivedTaskIds.sort()).toEqual(["T-A", "T-B"]);
  });
});
