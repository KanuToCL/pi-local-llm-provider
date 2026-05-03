/**
 * Tests for AUDIT-C #6: PendingConfirmsRegistry.expire is called periodically
 * by the daemon, and each expired entry produces a `confirm_timed_out` audit
 * row.
 *
 * We exercise this directly against the registry + audit log rather than
 * booting the full daemon, because the daemon's interval is 60s and even
 * with fake timers a full boot is heavier than necessary to verify the
 * contract.  The wiring itself is exercised by a daemon smoke that asserts
 * the timer is registered (via spy on setInterval).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../../src/audit/log.js";
import { PendingConfirmsRegistry } from "../../src/tools/pending-confirms.js";
import type { AuditEntry } from "../../src/audit/schema.js";

let workDir: string;
let auditDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-auto-expire-"));
  auditDir = join(workDir, "audit");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readAuditEntries(): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  for (const f of files) {
    const raw = readFileSync(join(auditDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip */
      }
    }
  }
  return entries;
}

describe("AUDIT-C #6: pendingConfirms.expire + audit row emission", () => {
  it("expire(now) returns expired entries that the daemon turns into confirm_timed_out audit rows", async () => {
    const auditLog = new AuditLog({
      dir: auditDir,
      daemonStartTs: Date.now(),
    });
    let clock = 1_000_000;
    const reg = new PendingConfirmsRegistry({ now: () => clock });

    // Two confirms with short TTLs so we can advance the clock quickly.
    reg.create({
      taskId: "T1",
      question: "delete /foo",
      rationale: "cleanup",
      risk: "irreversible",
      channel: "telegram",
      ttlMs: 100,
    });
    reg.create({
      taskId: "T2",
      question: "rm -rf /bar",
      rationale: "cleanup",
      risk: "irreversible",
      channel: "whatsapp",
      ttlMs: 200,
    });

    // Advance the clock past the 1st TTL but not the 2nd.
    clock += 150;
    let expired = reg.expire(clock);
    expect(expired.length).toBe(1);
    for (const e of expired) {
      await auditLog.append({
        event: "confirm_timed_out",
        task_id: e.taskId,
        channel: e.channel,
        sender_id_hash: null,
        extra: { short_id: e.shortId },
      });
    }

    // Advance past the 2nd TTL.
    clock += 100;
    expired = reg.expire(clock);
    expect(expired.length).toBe(1);
    for (const e of expired) {
      await auditLog.append({
        event: "confirm_timed_out",
        task_id: e.taskId,
        channel: e.channel,
        sender_id_hash: null,
        extra: { short_id: e.shortId },
      });
    }

    const entries = readAuditEntries();
    const timedOut = entries.filter((e) => e.event === "confirm_timed_out");
    expect(timedOut.length).toBe(2);
    expect(timedOut.map((e) => e.task_id).sort()).toEqual(["T1", "T2"]);
  });

  it("expired entries are tagged for the timeout-vs-no distinction (AUDIT-C #10)", () => {
    let clock = 0;
    const reg = new PendingConfirmsRegistry({ now: () => clock });
    const created = reg.create({
      taskId: "T1",
      question: "x",
      rationale: "y",
      risk: "z",
      channel: "terminal",
      ttlMs: 10,
    });

    let resolution: boolean | "PENDING" = "PENDING";
    void created.promise.then((r) => {
      resolution = r;
    });

    clock = 100;
    reg.expire(clock);

    // The entry is now timed-out — consumeTimedOut should return true once.
    expect(reg.consumeTimedOut(created.id)).toBe(true);
    // Second call returns false (one-shot semantics).
    expect(reg.consumeTimedOut(created.id)).toBe(false);

    return Promise.resolve().then(() => {
      expect(resolution).toBe(false);
    });
  });

  it("user-no resolution does NOT mark the entry timed-out", () => {
    const reg = new PendingConfirmsRegistry();
    const created = reg.create({
      taskId: "T1",
      question: "x",
      rationale: "y",
      risk: "z",
      channel: "terminal",
    });
    reg.resolve(created.id, "no");
    // consumeTimedOut returns false because the entry resolved via the
    // user's reply, not via expire().
    expect(reg.consumeTimedOut(created.id)).toBe(false);
  });
});
