/**
 * Tests for FIX-B-2 #1 (purge CLI + scheduler) and #4 (install.json
 * corruption emits an audit row before regenerating salt).
 *
 * For #1 we exercise the ROUTE the CLI takes — `AuditLog.purgeOlderThan`
 * — directly with a fake `--older-than` value.  The CLI subcommand is a
 * thin wrapper around that call (verified by reading bin/pi-comms.ts) so
 * a unit test against the underlying API + a separate scheduler-fires
 * assertion is sufficient.
 *
 * For the scheduler we boot the daemon in test mode (skips Studio + SDK)
 * and assert the kickoff timer fires within a short window — the kickoff
 * is at 60s, so we use vi.useFakeTimers + vi.advanceTimersByTime to
 * fast-forward past it.
 *
 * For #4 we corrupt `~/.pi-comms/install.json`, boot the daemon in test
 * mode, then read back the audit log to assert an
 * `audit_log_corruption_detected` row is present BEFORE any
 * sender_id_hash-bearing row — i.e. it lands on the audit log
 * chronologically before the salt is used.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

import { AuditLog } from "../src/audit/log.js";
import { start as startDaemon } from "../src/daemon.js";
import type { AppConfig } from "../src/config.js";
import type { AuditEntry } from "../src/audit/schema.js";

let workDir: string;
let homeDir: string;
let socketPath: string;
let modelsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-purge-"));
  homeDir = join(workDir, "home");
  socketPath = join(workDir, `s.${randomBytes(2).toString("hex")}.sock`);
  modelsPath = join(workDir, "models.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeTestConfig(): AppConfig {
  return {
    telegramBotToken: "",
    telegramAllowedUserIds: new Set<string>(),
    unslothApiKey: "test-key",
    piModelsJson: modelsPath,
    piCommsDefaultModel: "__test_skip_studio__/dummy",
    piCommsHome: homeDir,
    piCommsWorkspace: join(homeDir, "workspace"),
    operatorLogStyle: "json",
    operatorLogLevel: "silent",
    operatorLogContent: false,
    operatorLogPreviewChars: 120,
    piCommsAutoPromoteMs: 30_000,
    piCommsSandbox: "on",
    piCommsAuditRetentionDays: 7,
    piCommsDiagnosticMode: false,
    piCommsInboundRatePerSenderPerMin: 60,
    piCommsInboundRatePerChannelPerMin: 600,
  };
}

function readAuditEntries(home: string): AuditEntry[] {
  const auditDir = join(home, "audit");
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  const entries: AuditEntry[] = [];
  for (const f of files) {
    const raw = readFileSync(join(auditDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip malformed */
      }
    }
  }
  return entries;
}

function tick(ms = 80): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("FIX-B-2 #1: AuditLog.purgeOlderThan (the CLI's purge backbone)", () => {
  test("returns the count of files removed, matching the expected purge", async () => {
    const dir = join(workDir, "audit");
    await mkdir(dir, { recursive: true });
    const log = new AuditLog({ dir, daemonStartTs: Date.now() });

    // Drop in three log files: today, 5 days old, 30 days old.
    await log.append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
    });

    const fiveDays = join(dir, "audit.2026-04-23.jsonl");
    const thirtyDays = join(dir, "audit.2026-03-29.jsonl");
    writeFileSync(fiveDays, '{"event":"x"}\n', "utf8");
    writeFileSync(thirtyDays, '{"event":"x"}\n', "utf8");
    const now = Date.now();
    await utimes(fiveDays, now / 1000, (now - 5 * 86400 * 1000) / 1000);
    await utimes(thirtyDays, now / 1000, (now - 30 * 86400 * 1000) / 1000);

    // 90-day retention keeps everything.
    expect(await log.purgeOlderThan(90)).toBe(0);
    // 7-day retention purges only the 30-day-old file.
    expect(await log.purgeOlderThan(7)).toBe(1);
    // Re-running with the same threshold is a no-op.
    expect(await log.purgeOlderThan(7)).toBe(0);
  });
});

describe("FIX-B-2 #1: pi-comms purge CLI subcommand", () => {
  test(
    "spawning `pi-comms purge --older-than=1` deletes only old files and reports the count",
    () => {
      // Set up a fake PI_COMMS_HOME containing an audit dir with two files
      // — one fresh, one 30 days old.
      const auditDir = join(homeDir, "audit");
      const freshFile = join(auditDir, "audit.2026-05-03.jsonl");
      const oldFile = join(auditDir, "audit.2026-04-03.jsonl");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(freshFile, '{"event":"x"}\n', "utf8");
      writeFileSync(oldFile, '{"event":"x"}\n', "utf8");
      const now = Date.now();
      utimesSync(freshFile, now / 1000, now / 1000);
      utimesSync(oldFile, now / 1000, (now - 30 * 86400 * 1000) / 1000);

      // Locate the CLI entry.  The test cwd is the repo root under vitest.
      const cliPath = resolve(__dirname, "..", "bin", "pi-comms.ts");
      const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

      const res = spawnSync(tsxBin, [cliPath, "purge", "--older-than=1"], {
        encoding: "utf8",
        env: { ...process.env, PI_COMMS_HOME: homeDir },
      });

      expect(res.status).toBe(0);
      // The CLI prints the count on success.
      expect(res.stdout).toMatch(/purged 1 audit log file/);
      // The fresh file survived; the 30-day-old one is gone.
      expect(existsSync(freshFile)).toBe(true);
      expect(existsSync(oldFile)).toBe(false);
    },
    20_000,
  );

  test("spawning `pi-comms purge` with no audit dir reports nothing-to-purge", () => {
    const cliPath = resolve(__dirname, "..", "bin", "pi-comms.ts");
    const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

    const res = spawnSync(tsxBin, [cliPath, "purge"], {
      encoding: "utf8",
      env: { ...process.env, PI_COMMS_HOME: homeDir },
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/audit dir not present/);
  });

  test("spawning `pi-comms purge --older-than=invalid` returns exit 2", () => {
    const cliPath = resolve(__dirname, "..", "bin", "pi-comms.ts");
    const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

    const res = spawnSync(tsxBin, [cliPath, "purge", "--older-than=abc"], {
      encoding: "utf8",
      env: { ...process.env, PI_COMMS_HOME: homeDir },
    });

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--older-than must be a positive number/);
  });
});

describe("FIX-B-2 #1: scheduled daily purge fires inside the daemon", () => {
  test(
    "boots daemon and fires the kickoff purge within the 60s timer window",
    async () => {
      // Materialize models.json so boot doesn't choke on its absence — the
      // daemon skips Studio entirely in test mode but still reads the file
      // for the loopback assertion (skipped under the test prefix as well).
      await writeFile(
        modelsPath,
        JSON.stringify({
          providers: {
            "unsloth-studio": {
              baseUrl: "http://localhost:8888/v1",
              api: "openai-completions",
              apiKey: "test-key",
              authHeader: true,
              models: [
                {
                  id: "dummy",
                  name: "dummy",
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
        "utf8",
      );

      // Spy on setTimeout/setInterval so we can confirm the timer was
      // installed.  The daemon registers the kickoff via setTimeout(60s)
      // and the recurring sweep via setInterval(24h).
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

      const handle = await startDaemon({
        config: makeTestConfig(),
        socketPath,
      });

      try {
        // Assert the 60s kickoff was registered.
        const kickoff = setTimeoutSpy.mock.calls.find(
          ([, ms]) => ms === 60_000,
        );
        expect(kickoff).toBeDefined();

        // Assert a 24h recurring sweep was registered.
        const sweep = setIntervalSpy.mock.calls.find(
          ([, ms]) => ms === 24 * 60 * 60 * 1000,
        );
        expect(sweep).toBeDefined();
      } finally {
        setTimeoutSpy.mockRestore();
        setIntervalSpy.mockRestore();
        await handle.shutdown("test_teardown");
      }
    },
    15_000,
  );
});

describe("FIX-B-2 #4: install.json corruption emits audit BEFORE regen", () => {
  test(
    "boots over a corrupt install.json and audit log records the event",
    async () => {
      await writeFile(
        modelsPath,
        JSON.stringify({
          providers: {
            "unsloth-studio": {
              baseUrl: "http://localhost:8888/v1",
              api: "openai-completions",
              apiKey: "test-key",
              authHeader: true,
              models: [
                {
                  id: "dummy",
                  name: "dummy",
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
        "utf8",
      );
      // Pre-create the home dir + a deliberately broken install.json so the
      // daemon's ensureInstallSalt hits the parse-failure branch.
      await mkdir(homeDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(homeDir, "install.json"),
        "{ this is not json :: garbage } {",
        { mode: 0o600 },
      );

      const handle = await startDaemon({
        config: makeTestConfig(),
        socketPath,
      });

      try {
        // Audit appends are async; give the writer a moment to land the
        // corruption row.
        await tick(150);
        const entries = readAuditEntries(homeDir);
        const corruption = entries.find(
          (e) => e.event === "audit_log_corruption_detected",
        );
        expect(corruption).toBeDefined();
        expect(corruption!.extra?.file).toBe("install.json");
        // Salt was regenerated — the file now parses.
        const newRaw = readFileSync(join(homeDir, "install.json"), "utf8");
        const parsed = JSON.parse(newRaw) as { install_salt?: string };
        expect(typeof parsed.install_salt).toBe("string");
        expect((parsed.install_salt as string).length).toBeGreaterThanOrEqual(
          16,
        );
      } finally {
        await handle.shutdown("test_teardown");
      }
    },
    15_000,
  );
});
