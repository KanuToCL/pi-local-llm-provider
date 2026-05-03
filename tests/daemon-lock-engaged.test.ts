/**
 * Tests for the lockState gate (`/lock` panic-mode) in daemon.ts.
 *
 * AUDIT-D #3: when `/lock` flips lockState.locked = true, the daemon must
 * refuse every non-`/unlock` inbound message and emit a `lock_engaged_reject`
 * audit row.  This test exercises the gate at the IPC entry path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { start as startDaemon } from "../src/daemon.js";
import { IpcClient } from "../src/ipc/client.js";
import { readToken } from "../src/ipc/protocol.js";
import type { AppConfig } from "../src/config.js";
import type { AuditEntry } from "../src/audit/schema.js";

let workDir: string;
let homeDir: string;
let socketPath: string;
let modelsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-lock-engaged-"));
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
    piCommsAuditRetentionDays: 90,
    piCommsDiagnosticMode: false,
    piCommsInboundRatePerSenderPerMin: 10,
    piCommsInboundRatePerChannelPerMin: 30,
  };
}

async function writeFakeModelsJson(): Promise<void> {
  const content = JSON.stringify(
    {
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
    },
    null,
    2,
  );
  await writeFile(modelsPath, content, "utf8");
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

describe("daemon — lockState gate (RS-2)", () => {
  it("after /lock, refuses non-/unlock input + emits lock_engaged_reject + system_notice", async () => {
    await writeFakeModelsJson();
    const handle = await startDaemon({
      config: makeTestConfig(),
      socketPath,
    });
    const token = await readToken(handle.tokenPath);
    const events: { type: string; payload: unknown }[] = [];
    const client = new IpcClient({
      socketPath: handle.socketPath,
      authToken: token,
      onEvent: (type, payload) => events.push({ type, payload }),
    });

    try {
      await client.attach("all", "lock-test");

      // Engage the lock.
      await client.send("/lock");
      await tick();

      // Drain any /lock reply events so the next assertions are clean.
      events.length = 0;

      // A subsequent non-/unlock message should be refused.
      await client.send("hello");
      await tick();

      const notice = events.find(
        (e) =>
          e.type === "system_notice" &&
          String((e.payload as { text: string }).text).includes("locked"),
      );
      expect(notice).toBeDefined();

      const entries = readAuditEntries(homeDir);
      const rejected = entries.find(
        (e) => e.event === "lock_engaged_reject" && e.channel === "terminal",
      );
      expect(rejected).toBeDefined();
    } finally {
      client.close();
      await handle.shutdown("test_teardown");
    }
  });

  it("after /lock, /unlock from terminal is allowed and clears the gate", async () => {
    await writeFakeModelsJson();
    const handle = await startDaemon({
      config: makeTestConfig(),
      socketPath,
    });
    const token = await readToken(handle.tokenPath);
    const events: { type: string; payload: unknown }[] = [];
    const client = new IpcClient({
      socketPath: handle.socketPath,
      authToken: token,
      onEvent: (type, payload) => events.push({ type, payload }),
    });

    try {
      await client.attach("all", "lock-unlock-test");
      await client.send("/lock");
      await tick();
      events.length = 0;

      // /unlock from terminal must be allowed even though the gate is up.
      await client.send("/unlock");
      await tick();

      const reply = events.find(
        (e) =>
          e.type === "reply" &&
          String((e.payload as { text: string }).text).match(/unlock/i),
      );
      expect(reply).toBeDefined();

      // Now a normal /status should land (the gate is down).
      events.length = 0;
      await client.send("/status");
      await tick();
      const statusReply = events.find((e) => e.type === "reply");
      expect(statusReply).toBeDefined();
      expect(
        String((statusReply!.payload as { text: string }).text),
      ).toMatch(/sandbox: on/);
    } finally {
      client.close();
      await handle.shutdown("test_teardown");
    }
  });
});
