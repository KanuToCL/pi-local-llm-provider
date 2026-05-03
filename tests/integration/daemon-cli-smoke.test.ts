/**
 * End-to-end smoke for `src/daemon.ts` + `bin/pi-comms.ts`.
 *
 * Per IMPL-16 W4 brief: hermetic, no Studio, no Telegram. We exercise the
 * boot path that:
 *   - Materializes ~/.pi-comms (mode 0700) with the install salt + the IPC
 *     auth token.
 *   - Brings the IPC server online (chmod 600 socket).
 *   - Skips Studio + Telegram via the test-mode marker
 *     (`PI_COMMS_DEFAULT_MODEL=__test_skip_studio__/...`).
 *   - Accepts an attached IpcClient, processes a `/status` slash command via
 *     the slash router, and responds with a `reply` event.
 *   - Cleans up on `shutdown()` and writes a `daemon_shutdown` audit row.
 *
 * We bypass spawning the CLI binary directly; using `IpcClient` from the same
 * process exercises identical wire-protocol paths and avoids tsx-startup
 * latency in CI. A separate fork-based test could spawn `bin/pi-comms.ts`
 * proper, but the wire contract is the load-bearing surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { start as startDaemon } from "../../src/daemon.js";
import { IpcClient } from "../../src/ipc/client.js";
import { readToken } from "../../src/ipc/protocol.js";
import type { AppConfig } from "../../src/config.js";
import type { AuditEntry } from "../../src/audit/schema.js";

let workDir: string;
let homeDir: string;
let socketPath: string;
let modelsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-daemon-smoke-"));
  homeDir = join(workDir, "home");
  // Keep socket path well under the 104-char Unix domain socket cap.
  socketPath = join(workDir, `s.${randomBytes(2).toString("hex")}.sock`);
  modelsPath = join(workDir, "models.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Build a minimal AppConfig for the test daemon. The `__test_skip_studio__`
 * model marker tells `daemon.ts` to skip Studio probing AND skip SDK init —
 * we can boot the IPC server without external services.
 */
function makeTestConfig(): AppConfig {
  return {
    telegramBotToken: "", // unset → telegram disabled
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
    2
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

function tick(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("daemon — boot tree + IPC bringup (test mode)", () => {
  it("creates ~/.pi-comms with mode 0700, materializes ipc-token + install.json", async () => {
    await writeFakeModelsJson();
    const handle = await startDaemon({
      config: makeTestConfig(),
      socketPath,
    });
    try {
      // Home dir exists.
      expect(existsSync(homeDir)).toBe(true);
      // ipc-token + install.json both present + mode 0600 on POSIX.
      const tokenPath = join(homeDir, "ipc-token");
      const installPath = join(homeDir, "install.json");
      expect(existsSync(tokenPath)).toBe(true);
      expect(existsSync(installPath)).toBe(true);
      if (process.platform !== "win32") {
        expect((statSync(tokenPath).mode & 0o777).toString(8)).toBe("600");
        expect((statSync(installPath).mode & 0o777).toString(8)).toBe("600");
      }
      // Auth token shape sanity.
      const token = await readToken(tokenPath);
      expect(token.length).toBeGreaterThanOrEqual(32);
    } finally {
      await handle.shutdown("test_teardown");
    }
  });

  it.skipIf(process.platform === "win32")(
    "binds the socket file at mode 0600 after boot",
    async () => {
      await writeFakeModelsJson();
      const handle = await startDaemon({
        config: makeTestConfig(),
        socketPath,
      });
      try {
        const st = statSync(socketPath);
        expect((st.mode & 0o777).toString(8)).toBe("600");
      } finally {
        await handle.shutdown("test_teardown");
      }
    }
  );
});

describe("daemon — IPC client round-trip", () => {
  it("an attached client receives an attach-ack and can issue /status", async () => {
    await writeFakeModelsJson();
    const handle = await startDaemon({
      config: makeTestConfig(),
      socketPath,
    });
    const tokenPathStr = handle.tokenPath;
    const token = await readToken(tokenPathStr);

    const client = new IpcClient({
      socketPath: handle.socketPath,
      authToken: token,
    });
    const events: { type: string; payload: unknown }[] = [];
    client.close(); // drop and rebuild with onEvent registered
    const realClient = new IpcClient({
      socketPath: handle.socketPath,
      authToken: token,
      onEvent: (type, payload) => {
        events.push({ type, payload });
      },
    });
    try {
      await realClient.attach("all", "smoke-cli");

      // /status slash command — via `send` verb. Daemon's slash router gates
      // it as terminal-only-aware; isTerminal=true for IPC senders.
      await realClient.send("/status");
      await tick(120);
      const reply = events.find((e) => e.type === "reply");
      expect(reply).toBeDefined();
      const replyText = String((reply!.payload as { text: string }).text);
      // The slash router formats `task: idle` + `sandbox: on` for /status.
      expect(replyText).toMatch(/task: idle/);
      expect(replyText).toMatch(/sandbox: on/);
    } finally {
      realClient.close();
      await handle.shutdown("test_teardown");
    }
  });

  it("client.detach leaves the daemon running", async () => {
    await writeFakeModelsJson();
    const handle = await startDaemon({
      config: makeTestConfig(),
      socketPath,
    });
    const token = await readToken(handle.tokenPath);
    const client = new IpcClient({
      socketPath: handle.socketPath,
      authToken: token,
    });
    try {
      await client.attach("all", "ephemeral");
      await client.detach();
      // After detach, a fresh client can still attach — daemon stays alive.
      const second = new IpcClient({
        socketPath: handle.socketPath,
        authToken: token,
      });
      try {
        await expect(second.attach("all", "second")).resolves.toBeUndefined();
      } finally {
        second.close();
      }
    } finally {
      client.close();
      await handle.shutdown("test_teardown");
    }
  });
});

describe("daemon — graceful shutdown emits audit row", () => {
  it("cleanly closes the IPC server + writes a daemon_shutdown audit entry", async () => {
    await writeFakeModelsJson();
    const handle = await startDaemon({
      config: makeTestConfig(),
      socketPath,
    });
    await handle.shutdown("test_teardown");

    // Socket file should be unlinked on POSIX after server.stop.
    if (process.platform !== "win32") {
      expect(existsSync(handle.socketPath)).toBe(false);
    }
    const entries = readAuditEntries(homeDir);
    const shutdown = entries.find(
      (e) =>
        e.event === "daemon_shutdown" &&
        e.extra?.reason === "test_teardown"
    );
    expect(shutdown).toBeDefined();
  });
});

describe("daemon — Studio readiness URL helpers", () => {
  it("rejects non-loopback Studio URLs", async () => {
    const { assertLoopbackUrl, DaemonBootError } = await import(
      "../../src/daemon.js"
    );
    expect(() => assertLoopbackUrl("http://192.168.1.10:8888/v1")).toThrow(
      DaemonBootError
    );
    expect(() => assertLoopbackUrl("http://example.com/v1")).toThrow(
      DaemonBootError
    );
  });

  it("accepts loopback URLs (localhost / 127.0.0.1 / ::1)", async () => {
    const { assertLoopbackUrl } = await import("../../src/daemon.js");
    expect(() =>
      assertLoopbackUrl("http://localhost:8888/v1")
    ).not.toThrow();
    expect(() =>
      assertLoopbackUrl("http://127.0.0.1:8888/v1")
    ).not.toThrow();
    expect(() => assertLoopbackUrl("http://[::1]:8888/v1")).not.toThrow();
  });

  it("extracts Studio base URL + model id from provider/model spec", async () => {
    const { extractStudioBaseUrl, extractModelId } = await import(
      "../../src/daemon.js"
    );
    const fakeModels = {
      providers: {
        "unsloth-studio": {
          baseUrl: "http://localhost:8888/v1",
          api: "openai-completions",
          apiKey: "k",
          authHeader: true,
          models: [
            {
              id: "qwen",
              input: ["text"],
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    } as unknown as Parameters<typeof extractStudioBaseUrl>[0];
    expect(extractStudioBaseUrl(fakeModels, "unsloth-studio/qwen")).toBe(
      "http://localhost:8888/v1"
    );
    expect(extractModelId("unsloth-studio/qwen")).toBe("qwen");
  });
});
