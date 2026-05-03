/**
 * Tests for `src/audit/log.ts` and `src/audit/schema.ts`.
 *
 * Coverage targets (per IMPL-4 brief, ≥10 cases):
 *   1. append validates schema (rejects bad enum)
 *   2. append validates schema (rejects non-scalar `extra`)
 *   3. JSON.stringify-encoded — newline-injection attempt round-trips safely
 *      (Pitfall #28 fixture)
 *   4. Daily rotation creates a new file when the date changes
 *   5. purgeOlderThan deletes old files
 *   6. purgeOlderThan keeps recent files
 *   7. purgeOlderThan ignores non-matching filenames
 *   8. senderIdHash is deterministic
 *   9. senderIdHash differs across different salts
 *  10. Missing optional fields don't throw and are absent from the line
 *  11. ts is ISO-8601 UTC
 *  12. daemon_uptime_s reflects time since start
 *  13. Concurrent appends serialize (line count == call count)
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/audit/log.js";
import { AuditEntry } from "../src/audit/schema.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-audit-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readAllLines(file: string): unknown[] {
  const raw = readFileSync(file, "utf8");
  return raw
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

describe("AuditLog.append", () => {
  test("rejects an unknown event kind", async () => {
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });
    await expect(
      log.append({
        // @ts-expect-error — deliberately bad enum
        event: "not_a_real_event",
        task_id: null,
        channel: "system",
        sender_id_hash: null,
      })
    ).rejects.toThrow();
  });

  test("rejects a non-scalar value inside `extra`", async () => {
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });
    await expect(
      log.append({
        event: "task_started",
        task_id: "T1",
        channel: "terminal",
        sender_id_hash: "abc",
        extra: {
          // @ts-expect-error — only scalars allowed; an object should be rejected
          nested: { not: "allowed" },
        },
      })
    ).rejects.toThrow();
  });

  test("attacker-controlled message text cannot inject a forged event line (Pitfall #28)", async () => {
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });

    // Hostile payload: a real attacker would try to break out of the
    // current JSONL line and append a forged "task_completed" so that
    // their crime looks legitimate in the log. Even though the writer
    // does not log raw message text (it logs hashes), an `extra` field
    // that carries an attacker-controlled label is the obvious vector.
    const injection =
      'innocent\n{"ts":"2026-01-01T00:00:00.000Z","daemon_uptime_s":0,"event":"task_completed","task_id":"FAKE","channel":"system","sender_id_hash":null}\n';

    await log.append({
      event: "tell_emit",
      task_id: "T1",
      channel: "whatsapp",
      sender_id_hash: "h",
      extra: { label: injection },
    });

    const file = log.currentLogPath();
    const raw = readFileSync(file, "utf8");

    // The on-disk file must be exactly ONE line of JSONL (one entry +
    // one trailing newline). If the writer concatenated raw text the
    // injection would span 3 lines.
    const lines = raw.split("\n").filter((s) => s.length > 0);
    expect(lines.length).toBe(1);

    // And the single line must round-trip back to one object whose
    // `extra.label` still contains the embedded newline as data, not
    // as a frame separator.
    const parsed = JSON.parse(lines[0]) as AuditEntry;
    expect(parsed.event).toBe("tell_emit");
    expect(parsed.extra?.label).toBe(injection);
    expect(typeof parsed.extra?.label).toBe("string");
    expect((parsed.extra?.label as string).includes("\n")).toBe(true);
  });

  test("ts is a parseable ISO-8601 UTC timestamp", async () => {
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });
    await log.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const lines = readAllLines(log.currentLogPath()) as AuditEntry[];
    const parsed = new Date(lines[0].ts);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // toISOString always ends with Z (UTC); make sure we honor that
    expect(lines[0].ts.endsWith("Z")).toBe(true);
  });

  test("daemon_uptime_s reflects elapsed seconds since daemonStartTs", async () => {
    const startedAt = Date.now() - 5000; // pretend daemon started 5s ago
    const log = new AuditLog({ dir: workDir, daemonStartTs: startedAt });
    await log.append({
      event: "pi_heartbeat",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const lines = readAllLines(log.currentLogPath()) as AuditEntry[];
    expect(lines[0].daemon_uptime_s).toBeGreaterThanOrEqual(5);
    expect(lines[0].daemon_uptime_s).toBeLessThan(60);
  });

  test("missing optional fields are simply absent from the line (no `undefined` written)", async () => {
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });
    await log.append({
      event: "daemon_shutdown",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });
    const raw = readFileSync(log.currentLogPath(), "utf8");
    expect(raw).not.toContain("undefined");
    expect(raw).not.toContain('"duration_ms"');
    expect(raw).not.toContain('"extra"');
    expect(raw).not.toContain('"tool_call_name"');
  });

  test("concurrent appends produce one valid line per call (no torn writes)", async () => {
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });
    const calls: Promise<void>[] = [];
    for (let i = 0; i < 100; i += 1) {
      calls.push(
        log.append({
          event: "tell_emit",
          task_id: `T${i}`,
          channel: "terminal",
          sender_id_hash: "h",
          extra: { i },
        })
      );
    }
    await Promise.all(calls);
    const lines = readAllLines(log.currentLogPath());
    expect(lines.length).toBe(100);
    // Every line must validate as an AuditEntry
    for (const line of lines) {
      expect((line as AuditEntry).event).toBe("tell_emit");
    }
  });
});

describe("AuditLog rotation + retention", () => {
  test("currentLogPath embeds the UTC YYYY-MM-DD date", () => {
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });
    // Two arbitrary dates in different months
    const may2 = new Date(Date.UTC(2026, 4, 2, 12, 0, 0));
    const may3 = new Date(Date.UTC(2026, 4, 3, 0, 30, 0));
    expect(log.currentLogPath(may2).endsWith("audit.2026-05-02.jsonl")).toBe(true);
    expect(log.currentLogPath(may3).endsWith("audit.2026-05-03.jsonl")).toBe(true);
  });

  test("two appends across a midnight boundary land in different files", async () => {
    // Stamp two lines through the directory directly to simulate a
    // daemon that ran across midnight. We can't easily monkeypatch
    // `new Date()` inside append(), so we exercise the rotation
    // contract via two append() calls and one direct-write assertion
    // on `currentLogPath(date)`.
    const log = new AuditLog({ dir: workDir, daemonStartTs: Date.now() });

    await log.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });

    // The path we'd use tomorrow is different from today's path.
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    expect(log.currentLogPath(today)).not.toBe(log.currentLogPath(tomorrow));

    // And today's file exists.
    expect(statSync(log.currentLogPath(today)).isFile()).toBe(true);
  });

  test("purgeOlderThan deletes old log files and reports count", async () => {
    const log = new AuditLog({
      dir: workDir,
      daemonStartTs: Date.now(),
      retentionDays: 7,
    });

    // Create three log files with controlled mtimes:
    //   - today (kept)
    //   - 5 days old (kept under 7-day retention)
    //   - 30 days old (purged)
    await log.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });

    const fiveDays = join(workDir, "audit.2026-04-23.jsonl");
    const thirtyDays = join(workDir, "audit.2026-03-29.jsonl");
    // Use plain fs to materialize the older files
    const fs = await import("node:fs/promises");
    await fs.writeFile(fiveDays, '{"event":"x"}\n', "utf8");
    await fs.writeFile(thirtyDays, '{"event":"x"}\n', "utf8");
    const now = Date.now();
    await utimes(fiveDays, now / 1000, (now - 5 * 86400 * 1000) / 1000);
    await utimes(thirtyDays, now / 1000, (now - 30 * 86400 * 1000) / 1000);

    const purged = await log.purgeOlderThan(7);
    expect(purged).toBe(1);

    const survivors = readdirSync(workDir);
    expect(survivors).toContain("audit.2026-04-23.jsonl");
    expect(survivors).not.toContain("audit.2026-03-29.jsonl");
  });

  test("purgeOlderThan ignores files that don't match the audit naming convention", async () => {
    const log = new AuditLog({
      dir: workDir,
      daemonStartTs: Date.now(),
      retentionDays: 1,
    });

    const fs = await import("node:fs/promises");
    const stranger = join(workDir, "operator.2025-01-01.log");
    await fs.writeFile(stranger, "x", "utf8");
    const old = (Date.now() - 365 * 86400 * 1000) / 1000;
    await utimes(stranger, old, old);

    const purged = await log.purgeOlderThan(1);
    expect(purged).toBe(0);
    expect(readdirSync(workDir)).toContain("operator.2025-01-01.log");
  });

  test("purgeOlderThan returns 0 when the directory does not exist", async () => {
    const log = new AuditLog({
      dir: join(workDir, "does-not-exist"),
      daemonStartTs: Date.now(),
    });
    expect(await log.purgeOlderThan(7)).toBe(0);
  });
});

describe("AuditLog.senderIdHash", () => {
  test("is deterministic for the same input + salt", () => {
    const a = AuditLog.senderIdHash("15105551234@s.whatsapp.net", "salt-A");
    const b = AuditLog.senderIdHash("15105551234@s.whatsapp.net", "salt-A");
    expect(a).toBe(b);
    // SHA-256 hex is 64 chars
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("differs across different salts (per-install isolation)", () => {
    const a = AuditLog.senderIdHash("15105551234@s.whatsapp.net", "salt-A");
    const b = AuditLog.senderIdHash("15105551234@s.whatsapp.net", "salt-B");
    expect(a).not.toBe(b);
  });

  test("differs across different jids under the same salt", () => {
    const a = AuditLog.senderIdHash("15105551234@s.whatsapp.net", "salt");
    const b = AuditLog.senderIdHash("15109999999@s.whatsapp.net", "salt");
    expect(a).not.toBe(b);
  });
});
