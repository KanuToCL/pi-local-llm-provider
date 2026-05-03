/**
 * Tests for AUDIT-C #9: SessionManager passes the running TaskState's
 * AbortController.signal into pi-mono's session.prompt() so /cancel can
 * actually stop the GPU.
 *
 * The SDK is mocked via loadSdkOverride; we capture the `options.signal`
 * argument and assert it's the same controller's signal we install on the
 * TaskState transition.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../../src/session.js";
import { TaskStateManager } from "../../src/lib/task-state.js";
import { PendingConfirmsRegistry } from "../../src/tools/pending-confirms.js";
import { SandboxPolicy } from "../../src/sandbox/policy.js";
import { JsonStore } from "../../src/storage/json-store.js";
import { AuditLog } from "../../src/audit/log.js";
import { noopOperatorLogger } from "../../src/utils/operator-logger.js";
import type { AppConfig } from "../../src/config.js";
import type { SdkLoaded } from "../../src/lib/sdk-shim.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-abort-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeAppConfig(): AppConfig {
  return {
    telegramBotToken: "",
    telegramAllowedUserIds: new Set<string>(),
    unslothApiKey: "test",
    piModelsJson: join(workDir, "models.json"),
    piCommsDefaultModel: "p/m",
    piCommsHome: workDir,
    piCommsWorkspace: join(workDir, "workspace"),
    operatorLogStyle: "json",
    operatorLogLevel: "silent",
    operatorLogContent: false,
    operatorLogPreviewChars: 80,
    piCommsAutoPromoteMs: 999_999,
    piCommsSandbox: "on",
    piCommsAuditRetentionDays: 90,
    piCommsDiagnosticMode: false,
  };
}

describe("AUDIT-C #9: AbortController.signal flows from TaskState into pi-mono", () => {
  it("session.prompt receives a real AbortSignal from the running TaskState", async () => {
    const config = makeAppConfig();
    const taskState = new TaskStateManager({
      persistencePath: join(workDir, "task-state.json"),
    });
    const pendingConfirms = new PendingConfirmsRegistry();
    const sandboxPolicy = new SandboxPolicy({
      jsonStore: new JsonStore(join(workDir, "sandbox.json")),
    });
    const auditLog = new AuditLog({
      dir: join(workDir, "audit"),
      daemonStartTs: Date.now(),
    });

    // Capture the prompt options on each call.
    const capturedOptions: unknown[] = [];
    let promptResolve: (() => void) = () => undefined;
    const promptPromise = new Promise<void>((r) => {
      promptResolve = r;
    });

    const fakeSession = {
      subscribe: () => () => undefined,
      prompt: vi.fn(async (_text: string, options?: unknown) => {
        capturedOptions.push(options);
        // Wait for test to release us so /cancel-style abort can fire mid-flight.
        await promptPromise;
      }),
      abort: async () => undefined,
    };

    const sdk: SdkLoaded = {
      createAgentSession: async () => ({ session: fakeSession }) as never,
      defineTool: (def: unknown) => def,
      raw: {},
    };

    const sm = new SessionManager({
      config,
      taskState,
      pendingConfirms,
      sandboxPolicy,
      auditLog,
      operatorLogger: noopOperatorLogger,
      sinks: {},
      loadSdkOverride: async () => sdk,
      validateModelsJsonOverride: async () => undefined,
    });
    await sm.init();

    // Kick off an inbound and let prompt() reach the await point.
    const inboundPromise = sm.handleInbound({
      channel: "terminal",
      text: "do the thing",
    });
    await new Promise((r) => setTimeout(r, 30));

    // The first call to prompt should have received options.signal.
    expect(capturedOptions.length).toBe(1);
    const opts = capturedOptions[0] as { signal?: AbortSignal };
    expect(opts).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal!.aborted).toBe(false);

    // Now grab the live AbortController from TaskState and abort it —
    // the signal we passed into prompt should reflect that abort.
    const live = taskState.get();
    expect(live.kind).toBe("running");
    if (live.kind === "running") {
      live.abort.abort();
    }
    expect(opts.signal!.aborted).toBe(true);

    // Release the prompt so the inbound handler can finish cleanly.
    promptResolve();
    await inboundPromise;
    await sm.dispose();
  });
});
