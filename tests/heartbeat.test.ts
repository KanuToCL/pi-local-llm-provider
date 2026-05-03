/**
 * Tests for `src/lib/heartbeat.ts` (PE Skeptic Round 2 #2 — message-loop
 * touched heartbeat).
 *
 * Coverage targets (per IMPL-19 brief, ≥10 cases):
 *   1.  Default state with no touchAlive calls → 'dead'
 *   2.  All required sources fresh → 'healthy' + heartbeat file written
 *   3.  One source older than degradedMaxAgeMs → 'dead' (not healthy)
 *   4.  One source older than healthyMaxAgeMs but within degraded window
 *       → 'degraded' (not healthy, even though other sources are fresh —
 *       message loop requires ALL required sources)
 *   5.  Heartbeat file is NOT written when any required source is stale
 *       (PE Skeptic R2 — file freshness reflects message loop, not
 *       a setInterval)
 *   6.  Transition healthy → degraded emits pi_stuck_suspected; transition
 *       back to healthy emits pi_heartbeat
 *   7.  Transition healthy → dead emits pi_stuck_suspected
 *   8.  Repeated touches in healthy state DO NOT emit duplicate
 *       pi_heartbeat events
 *   9.  Unknown source name throws (rejects)
 *  10.  reset() clears in-memory state and on-disk file
 *  11.  Snapshot reports per-source ages and the file age accurately
 *  12.  requiredSources subset — Telegram-only daemon goes healthy
 *       without baileys-poll
 *  13.  Constructor rejects degradedMaxAgeMs <= healthyMaxAgeMs
 *  14.  Touch in 'pi-ping' alone after the others are stale produces
 *       'degraded' and does NOT touch the file
 *  15.  Concurrent touches from multiple sources do not produce torn
 *       writes (single line, atomic rename)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/audit/log.js";
import { Heartbeat } from "../src/lib/heartbeat.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-heartbeat-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readAuditLines(dir: string): unknown[] {
  // The AuditLog rotates daily; tests rarely span midnight so reading
  // every audit.*.jsonl file in the dir is sufficient.
  if (!existsSync(dir)) return [];
  const lines: unknown[] = [];
  for (const name of require("node:fs").readdirSync(dir)) {
    if (!name.startsWith("audit.") || !name.endsWith(".jsonl")) continue;
    const raw = readFileSync(join(dir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      lines.push(JSON.parse(line));
    }
  }
  return lines;
}

interface Harness {
  hb: Heartbeat;
  audit: AuditLog;
  auditDir: string;
  heartbeatPath: string;
  /** Mutable now-getter so tests can advance the clock. */
  setNow: (ms: number) => void;
}

function buildHarness(opts?: {
  healthyMaxAgeMs?: number;
  degradedMaxAgeMs?: number;
  requiredSources?: ("baileys-poll" | "telegram-poll" | "pi-ping")[];
}): Harness {
  let nowMs = 1_000_000_000_000;
  const auditDir = join(workDir, "audit");
  const audit = new AuditLog({ dir: auditDir, daemonStartTs: nowMs });
  const heartbeatPath = join(workDir, "daemon.heartbeat");
  const hb = new Heartbeat({
    heartbeatPath,
    healthyMaxAgeMs: opts?.healthyMaxAgeMs ?? 90_000,
    degradedMaxAgeMs: opts?.degradedMaxAgeMs ?? 180_000,
    requiredSources: opts?.requiredSources,
    auditLog: audit,
    now: () => nowMs,
  });
  return {
    hb,
    audit,
    auditDir,
    heartbeatPath,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

describe("Heartbeat — initial state", () => {
  test("no touches → 'dead'", async () => {
    const h = buildHarness();
    const state = await h.hb.getState();
    expect(state).toBe("dead");
  });
});

describe("Heartbeat — message-loop touched freshness gates", () => {
  test("all three sources fresh → 'healthy' and heartbeat file is written", async () => {
    const h = buildHarness();
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });

    expect(await h.hb.getState()).toBe("healthy");
    expect(existsSync(h.heartbeatPath)).toBe(true);
  });

  test("one source older than degradedMaxAgeMs → 'dead', file NOT touched", async () => {
    // Touch all three at t0. Then advance >180s and touch only two.
    // The third source's touch is now 180s+ stale → dead.
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });

    const fileMtimeAtHealthy = statSync(h.heartbeatPath).mtimeMs;

    // Advance 200s — pi-ping is now 200s stale.
    h.setNow(1_000_000_000_000 + 200_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });

    expect(await h.hb.getState()).toBe("dead");
    // File mtime must not have advanced (pi-ping is stale).
    const fileMtimeAfter = statSync(h.heartbeatPath).mtimeMs;
    expect(fileMtimeAfter).toBe(fileMtimeAtHealthy);
  });

  test("one source older than healthyMaxAgeMs but within degraded window → 'degraded'", async () => {
    // Touch all three. Advance 100s (>90s healthy, <180s degraded).
    // Touch only two of the three. The third source is 100s old.
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });

    h.setNow(1_000_000_000_000 + 100_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });

    expect(await h.hb.getState()).toBe("degraded");
  });

  test("file is NOT written when any required source is stale (PE Skeptic R2)", async () => {
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    // Touch only baileys + telegram; pi-ping is forever-stale.
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });

    expect(existsSync(h.heartbeatPath)).toBe(false);
    expect(await h.hb.getState()).toBe("dead");
  });

  test("touching only 'pi-ping' after others go stale → 'degraded' and file untouched", async () => {
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });

    const fileMtimeAtHealthy = statSync(h.heartbeatPath).mtimeMs;

    // Advance 100s (within degraded window). Only touch pi-ping.
    h.setNow(1_000_000_000_000 + 100_000);
    await h.hb.touchAlive({ source: "pi-ping" });

    expect(await h.hb.getState()).toBe("degraded");
    expect(statSync(h.heartbeatPath).mtimeMs).toBe(fileMtimeAtHealthy);
  });
});

describe("Heartbeat — state transitions emit audit events", () => {
  test("healthy → degraded emits pi_stuck_suspected; degraded → healthy emits pi_heartbeat", async () => {
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });
    // Force baseline emission.
    await h.hb.getState();

    // Drift to degraded.
    h.setNow(1_000_000_000_000 + 100_000);
    expect(await h.hb.getState()).toBe("degraded");

    // Recover by touching all three.
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });
    expect(await h.hb.getState()).toBe("healthy");

    const events = readAuditLines(h.auditDir).map((e: any) => e.event);
    expect(events).toContain("pi_stuck_suspected");
    expect(events).toContain("pi_heartbeat");
    // The order matters: stuck must come before recovery.
    expect(events.indexOf("pi_stuck_suspected")).toBeLessThan(
      events.indexOf("pi_heartbeat")
    );
  });

  test("healthy → dead emits pi_stuck_suspected", async () => {
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });
    await h.hb.getState(); // baseline

    // Drift well past dead threshold.
    h.setNow(1_000_000_000_000 + 600_000);
    expect(await h.hb.getState()).toBe("dead");

    const events = readAuditLines(h.auditDir).map((e: any) => e.event);
    expect(events).toContain("pi_stuck_suspected");
  });

  test("repeated touches in healthy state do not emit duplicate pi_heartbeat events", async () => {
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });
    await h.hb.getState(); // baseline (no event)

    // Touch many more times — none of these should emit since state
    // hasn't changed away from healthy.
    for (let i = 0; i < 5; i++) {
      h.setNow(1_000_000_000_000 + 1000 * (i + 1));
      await h.hb.touchAlive({ source: "baileys-poll" });
      await h.hb.touchAlive({ source: "telegram-poll" });
      await h.hb.touchAlive({ source: "pi-ping" });
    }

    const events = readAuditLines(h.auditDir).map((e: any) => e.event);
    expect(events.filter((e: string) => e === "pi_heartbeat")).toHaveLength(0);
  });
});

describe("Heartbeat — input validation", () => {
  test("unknown source name rejects", async () => {
    const h = buildHarness();
    await expect(
      // @ts-expect-error — deliberately bad source
      h.hb.touchAlive({ source: "not-a-real-source" })
    ).rejects.toThrow(/unknown heartbeat source/);
  });

  test("constructor rejects degradedMaxAgeMs <= healthyMaxAgeMs", () => {
    expect(() => {
      new Heartbeat({
        heartbeatPath: join(workDir, "daemon.heartbeat"),
        healthyMaxAgeMs: 90_000,
        degradedMaxAgeMs: 90_000,
      });
    }).toThrow(/degradedMaxAgeMs/);
  });

  test("constructor rejects empty requiredSources", () => {
    expect(() => {
      new Heartbeat({
        heartbeatPath: join(workDir, "daemon.heartbeat"),
        healthyMaxAgeMs: 90_000,
        degradedMaxAgeMs: 180_000,
        requiredSources: [],
      });
    }).toThrow(/at least one source/);
  });
});

describe("Heartbeat — reset and snapshot", () => {
  test("reset() clears in-memory state and on-disk file", async () => {
    const h = buildHarness();
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });
    expect(existsSync(h.heartbeatPath)).toBe(true);

    await h.hb.reset();

    expect(existsSync(h.heartbeatPath)).toBe(false);
    expect(await h.hb.getState()).toBe("dead");
  });

  test("snapshot reports per-source ages and the file age", async () => {
    const h = buildHarness();
    h.setNow(1_000_000_000_000);
    await h.hb.touchAlive({ source: "baileys-poll" });
    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });

    h.setNow(1_000_000_000_000 + 5000);
    const snap = await h.hb.snapshot();

    expect(snap.state).toBe("healthy");
    expect(snap.ages["baileys-poll"]).toBe(5000);
    expect(snap.ages["telegram-poll"]).toBe(5000);
    expect(snap.ages["pi-ping"]).toBe(5000);
    expect(snap.fileAgeMs).not.toBeNull();
    // File age may be 0..5000 depending on which touchAlive wrote it; we
    // just assert it's bounded.
    expect(snap.fileAgeMs).toBeGreaterThanOrEqual(0);
    expect(snap.fileAgeMs).toBeLessThanOrEqual(5000);
  });
});

describe("Heartbeat — required-source subset", () => {
  test("Telegram-only daemon goes healthy without baileys-poll", async () => {
    // When WhatsApp is not configured, the daemon constructs the
    // Heartbeat with requiredSources omitting baileys-poll. Otherwise the
    // gauge would pin at degraded forever.
    const h = buildHarness({
      requiredSources: ["telegram-poll", "pi-ping"],
    });

    await h.hb.touchAlive({ source: "telegram-poll" });
    await h.hb.touchAlive({ source: "pi-ping" });

    expect(await h.hb.getState()).toBe("healthy");
    expect(existsSync(h.heartbeatPath)).toBe(true);
  });
});

describe("Heartbeat — concurrent touches", () => {
  test("simultaneous touches do not produce torn writes; file remains a single valid line", async () => {
    const h = buildHarness();
    h.setNow(1_000_000_000_000);

    // Fire many touches concurrently. The serialized writeQueue inside
    // Heartbeat should ensure only-one-rename-at-a-time semantics.
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(h.hb.touchAlive({ source: "baileys-poll" }));
      promises.push(h.hb.touchAlive({ source: "telegram-poll" }));
      promises.push(h.hb.touchAlive({ source: "pi-ping" }));
    }
    await Promise.all(promises);

    expect(await h.hb.getState()).toBe("healthy");
    // File body is informational; just verify it's a single ISO timestamp.
    const body = readFileSync(h.heartbeatPath, "utf8");
    expect(body.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
