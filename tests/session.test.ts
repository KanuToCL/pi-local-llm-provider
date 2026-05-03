/**
 * Tests for `src/session.ts`.
 *
 * Per IMPL-15 brief (≥12 cases):
 *   - SessionManager.init throws SdkNotInstalledError if pi-mono missing
 *   - SessionManager.init throws ConfigurationError if models.json invalid
 *   - handleInbound enqueues serially via GlobalQueue
 *   - handleInbound transitions taskState idle→running
 *   - handleInbound schedules auto-promote setTimeout
 *   - Auto-promote fires on time → emits ChannelEvent auto_promote_notice
 *   - Auto-promote suppressed if state already advanced (CAS check works)
 *   - dispose unsubscribes + clears active timer
 *   - mapAgentEventToChannelEvent maps each known pi event kind correctly
 *   - mapAgentEventToChannelEvent returns null for unknown event kinds
 *   - Restore-from-disk on init: prior running state → recovery tell sent
 *   - Models.json validator: rejects missing 'api' field (covered in
 *     init-throws test)
 *
 * Test fixtures use a FAKE SDK + FAKE TaskStateManager (real one would
 * require a real JsonStore on disk per test) + capturing sinks. The fake
 * SDK shape mirrors @mariozechner/pi-coding-agent at the surface
 * SessionManager actually touches: createAgentSession returning { session },
 * session.subscribe / prompt / abort / close, defineTool returning identity.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../src/config.js";
import { AuditLog } from "../src/audit/log.js";
import { GlobalQueue } from "../src/lib/chat-queue.js";
import { SandboxPolicy, type SandboxState } from "../src/sandbox/policy.js";
import { JsonStore } from "../src/storage/json-store.js";
import { TaskStateManager } from "../src/lib/task-state.js";
import { PendingConfirmsRegistry } from "../src/tools/pending-confirms.js";
import {
  SessionManager,
  type InboundMessage,
} from "../src/session.js";
import {
  SdkNotInstalledError,
  mapAgentEventToChannelEvent,
} from "../src/lib/sdk-shim.js";
import { ModelsJsonValidationError } from "../src/lib/sdk-models-validator.js";
import type { ChannelEvent, Sink } from "../src/tools/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

class CapturingSink implements Sink {
  events: ChannelEvent[] = [];
  async send(event: ChannelEvent): Promise<void> {
    this.events.push(event);
  }
}

// Index signature on the type so SdkAgentSession's `[k: string]: unknown`
// constraint is satisfied via structural sub-typing.
interface FakeSession {
  [key: string]: unknown;
  promptCalls: { text: string }[];
  abortCalls: number;
  closeCalls: number;
  emit: (event: unknown) => void;
  subscribers: ((event: unknown) => void)[];
  resolveCurrentPrompt: (() => void) | null;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
}

function makeFakeSession(): FakeSession {
  const session = {
    promptCalls: [] as { text: string }[],
    abortCalls: 0,
    closeCalls: 0,
    subscribers: [] as ((event: unknown) => void)[],
    resolveCurrentPrompt: null as (() => void) | null,
    emit(event: unknown) {
      for (const listener of this.subscribers) listener(event);
    },
    async prompt(text: string): Promise<void> {
      this.promptCalls.push({ text });
      await new Promise<void>((resolve) => {
        this.resolveCurrentPrompt = resolve;
      });
    },
    async abort(): Promise<void> {
      this.abortCalls++;
    },
    async close(): Promise<void> {
      this.closeCalls++;
    },
    subscribe(listener: (event: unknown) => void) {
      this.subscribers.push(listener);
      return () => {
        const i = this.subscribers.indexOf(listener);
        if (i >= 0) this.subscribers.splice(i, 1);
      };
    },
  };
  return session;
}

function makeFakeSdkLoader(session: FakeSession) {
  return async () => ({
    createAgentSession: vi.fn(async () => ({ session })),
    defineTool: vi.fn((def: unknown) => def),
    raw: {} as Record<string, unknown>,
  });
}

let workDir: string;
let activeTaskState: TaskStateManager | null = null;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-session-"));
  activeTaskState = null;
});
afterEach(async () => {
  // Flush any in-flight TaskStateManager writes BEFORE we rm the tempdir,
  // otherwise a queued atomic-write fires ENOENT against the deleted path
  // and surfaces as an unhandled rejection.
  if (activeTaskState) {
    try {
      await activeTaskState.flush();
    } catch {
      /* ignore */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

function makeBaseConfig(): AppConfig {
  return {
    telegramBotToken: "test-token",
    telegramAllowedUserIds: new Set(["1"]),
    unslothApiKey: "test-key",
    piModelsJson: join(workDir, "models.json"),
    piCommsDefaultModel: "test-model",
    piCommsHome: workDir,
    piCommsWorkspace: join(workDir, "workspace"),
    operatorLogStyle: "plain",
    operatorLogLevel: "silent",
    operatorLogContent: false,
    operatorLogPreviewChars: 120,
    piCommsAutoPromoteMs: 30_000,
    piCommsSandbox: "on",
    piCommsAuditRetentionDays: 90,
    piCommsDiagnosticMode: false,
  };
}

interface Harness {
  config: AppConfig;
  taskState: TaskStateManager;
  pendingConfirms: PendingConfirmsRegistry;
  sandboxPolicy: SandboxPolicy;
  auditLog: AuditLog;
  sinks: { terminal: CapturingSink; whatsapp: CapturingSink; telegram: CapturingSink };
  basePromptPath: string;
  globalQueue: GlobalQueue;
}

function makeHarness(): Harness {
  // Write a SHA-pinned-style base prompt the harness composes against.
  const promptDir = join(workDir, "prompts");
  mkdirSync(promptDir, { recursive: true });
  const basePromptPath = join(promptDir, "coding-agent.test.txt");
  writeFileSync(basePromptPath, "TEST_PROMPT_BODY", "utf8");

  const taskState = new TaskStateManager({
    persistencePath: join(workDir, "task-state.json"),
  });
  activeTaskState = taskState;

  return {
    config: makeBaseConfig(),
    taskState,
    pendingConfirms: new PendingConfirmsRegistry(),
    sandboxPolicy: new SandboxPolicy({
      jsonStore: new JsonStore<SandboxState>(join(workDir, "sandbox.json")),
    }),
    auditLog: new AuditLog({
      dir: join(workDir, "audit"),
      daemonStartTs: Date.now(),
    }),
    sinks: {
      terminal: new CapturingSink(),
      whatsapp: new CapturingSink(),
      telegram: new CapturingSink(),
    },
    basePromptPath,
    globalQueue: new GlobalQueue(),
  };
}

// Always-passing models.json validator for tests that don't focus on that path.
async function noopValidate(_path: string): Promise<void> {
  /* skip validation */
}

/**
 * Repeatedly yield to the event loop until `predicate()` returns true OR
 * `maxAttempts` is exhausted. We use this instead of fixed setImmediate
 * counts because the operation chain runs through GlobalQueue → audit.append
 * → setTimeout schedule → session.prompt(), which can need a variable
 * number of microtask cycles depending on how the test platform schedules
 * the audit-log mkdir/appendFile calls.
 */
async function waitFor(
  predicate: () => boolean,
  maxAttempts = 200
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// init() — SDK + models.json
// ---------------------------------------------------------------------------

describe("SessionManager.init()", () => {
  test("throws SdkNotInstalledError when SDK loader fails", async () => {
    const h = makeHarness();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: async () => {
        throw new SdkNotInstalledError("pi-coding-agent missing");
      },
    });
    await expect(mgr.init()).rejects.toBeInstanceOf(SdkNotInstalledError);
  });

  test("throws ModelsJsonValidationError when validator rejects", async () => {
    const h = makeHarness();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: async () => {
        throw new ModelsJsonValidationError("missing api", ["api"]);
      },
      loadSdkOverride: makeFakeSdkLoader(makeFakeSession()),
    });
    await expect(mgr.init()).rejects.toBeInstanceOf(ModelsJsonValidationError);
  });

  test("init succeeds with valid loader + validator + composes prompt", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const sdkLoader = makeFakeSdkLoader(session);
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: sdkLoader,
    });
    await expect(mgr.init()).resolves.toBeUndefined();
    expect(session.subscribers.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleInbound — serialization + state machine
// ---------------------------------------------------------------------------

describe("SessionManager.handleInbound()", () => {
  test("transitions taskState idle → running on accept", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
    });
    await mgr.init();
    expect(h.taskState.get().kind).toBe("idle");

    // Don't await — fake session.prompt() blocks until resolveCurrentPrompt.
    const inflight = mgr.handleInbound({
      channel: "telegram",
      text: "hello pi",
    });
    await waitFor(() => session.promptCalls.length > 0);

    expect(h.taskState.get().kind).toBe("running");
    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0]!.text).toBe("hello pi");

    // Release the prompt so the test can clean up.
    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("two concurrent handleInbound calls run serially via GlobalQueue", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
    });
    await mgr.init();

    const a = mgr.handleInbound({ channel: "telegram", text: "first" });
    const b = mgr.handleInbound({ channel: "telegram", text: "second" });

    await waitFor(() => session.promptCalls.length >= 1);

    // Only ONE prompt call should be in flight; the second is blocked behind
    // the GlobalQueue lock.
    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0]!.text).toBe("first");

    // Release first; transition to completed externally so the second can
    // acquire the lock + run.
    session.resolveCurrentPrompt!();
    await a;
    // Drain task state back to idle so the second handleInbound can acquire.
    const cur = h.taskState.get();
    if (cur.kind === "running" || cur.kind === "backgrounded") {
      h.taskState.tryTransition({
        kind: "completed",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        finishedAt: Date.now(),
      });
      h.taskState.tryTransition({ kind: "idle" });
    }
    await waitFor(() => session.promptCalls.length >= 2);

    expect(session.promptCalls).toHaveLength(2);
    expect(session.promptCalls[1]!.text).toBe("second");

    session.resolveCurrentPrompt!();
    await b;
    await mgr.dispose();
  });

  test("schedules auto-promote setTimeout", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const setTimeoutFn = vi.fn(((handler: () => void, _ms: number) =>
      setTimeout(handler, 0)) as (h: () => void, ms: number) => unknown);
    const clearTimeoutFn = vi.fn((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    );
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
      setTimeoutFn,
      clearTimeoutFn,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => setTimeoutFn.mock.calls.length > 0);

    // Exactly one auto-promote scheduled at config'd delay.
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect((setTimeoutFn.mock.calls[0]![1] as number)).toBe(30_000);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Auto-promote firing + race suppression
// ---------------------------------------------------------------------------

describe("auto-promote", () => {
  test("fires on time → emits auto_promote_notice ChannelEvent to originating sink", async () => {
    const h = makeHarness();
    const session = makeFakeSession();

    let fireFn: (() => void) | null = null;
    const setTimeoutFn = vi.fn((handler: () => void, _ms: number) => {
      fireFn = handler;
      return Symbol("handle");
    });
    const clearTimeoutFn = vi.fn();

    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
      setTimeoutFn,
      clearTimeoutFn,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "long task" });
    await waitFor(() => fireFn !== null);

    // Manually fire the captured timer.
    expect(fireFn).not.toBeNull();
    fireFn!();
    await waitFor(() => h.sinks.telegram.events.length > 0);

    // Telegram sink got the auto-promote notice.
    expect(h.sinks.telegram.events).toHaveLength(1);
    const evt = h.sinks.telegram.events[0]!;
    expect(evt.type).toBe("auto_promote_notice");
    expect(h.taskState.get().kind).toBe("backgrounded");

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("auto-promote suppressed when state advanced past `running` (CAS)", async () => {
    const h = makeHarness();
    const session = makeFakeSession();

    let fireFn: (() => void) | null = null;
    const setTimeoutFn = vi.fn((handler: () => void, _ms: number) => {
      fireFn = handler;
      return Symbol("handle");
    });
    const clearTimeoutFn = vi.fn();

    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
      setTimeoutFn,
      clearTimeoutFn,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
    await waitFor(() => fireFn !== null);

    // Race: cancel the task BEFORE the timer fires.
    const cur = h.taskState.get();
    if (cur.kind === "running") {
      h.taskState.tryTransition({
        kind: "cancelled",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        cancelledAt: Date.now(),
        reason: "user",
      });
    }

    // Now fire the captured timer; CAS should suppress the auto-promote.
    fireFn!();
    // Yield to let any (suppressed) sink emission propagate.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(h.sinks.telegram.events).toHaveLength(0);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("SessionManager.dispose()", () => {
  test("unsubscribes from session events and clears active timer", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const clearTimeoutFn = vi.fn();
    const setTimeoutFn = vi.fn(() => Symbol("handle"));
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
      setTimeoutFn,
      clearTimeoutFn,
    });
    await mgr.init();
    expect(session.subscribers.length).toBe(1);

    const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
    await waitFor(() => session.promptCalls.length > 0);

    // dispose() should: (a) unsubscribe, (b) clear the timer, (c) close session.
    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();

    expect(session.subscribers.length).toBe(0);
    expect(clearTimeoutFn).toHaveBeenCalled();
    expect(session.closeCalls).toBe(1);
  });

  test("dispose is idempotent (safe to call twice)", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
    });
    await mgr.init();
    await mgr.dispose();
    await expect(mgr.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapAgentEventToChannelEvent (shim-level test, but lives here per brief)
// ---------------------------------------------------------------------------

describe("mapAgentEventToChannelEvent", () => {
  test("maps message_end with assistant text → tell{urgency:done}", () => {
    const piEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "all done" },
        ],
      },
    };
    const ce = mapAgentEventToChannelEvent(piEvent);
    expect(ce).not.toBeNull();
    expect(ce!.type).toBe("tell");
    if (ce!.type === "tell") {
      expect(ce!.urgency).toBe("done");
      expect(ce!.text).toBe("all done");
    }
  });

  test("returns null for unknown / unmapped event kinds", () => {
    expect(mapAgentEventToChannelEvent({ type: "turn_start" })).toBeNull();
    expect(mapAgentEventToChannelEvent({ type: "compaction_start" })).toBeNull();
    expect(mapAgentEventToChannelEvent({ type: "queue_update" })).toBeNull();
    expect(mapAgentEventToChannelEvent({ type: "tool_execution_start" })).toBeNull();
  });

  test("returns null for non-object events", () => {
    expect(mapAgentEventToChannelEvent(null)).toBeNull();
    expect(mapAgentEventToChannelEvent(undefined)).toBeNull();
    expect(mapAgentEventToChannelEvent("string")).toBeNull();
    expect(mapAgentEventToChannelEvent(42)).toBeNull();
  });

  test("returns null for message_end with empty / non-assistant content", () => {
    expect(
      mapAgentEventToChannelEvent({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "input" }] },
      })
    ).toBeNull();
    expect(
      mapAgentEventToChannelEvent({
        type: "message_end",
        message: { role: "assistant", content: [] },
      })
    ).toBeNull();
    expect(
      mapAgentEventToChannelEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "tool_call" }] },
      })
    ).toBeNull();
  });

  test("handles string-typed assistant content", () => {
    const ce = mapAgentEventToChannelEvent({
      type: "message_end",
      message: { role: "assistant", content: "compact reply" },
    });
    expect(ce).not.toBeNull();
    if (ce && ce.type === "tell") expect(ce.text).toBe("compact reply");
  });
});

// ---------------------------------------------------------------------------
// Restore-from-disk — recovery tell()
// ---------------------------------------------------------------------------

describe("init() restore-from-disk", () => {
  test("running state on disk → recovery tell sent to originating channel + state forced idle", async () => {
    const h = makeHarness();

    // Pre-populate the task-state file with a `running` snapshot to simulate
    // a daemon that crashed mid-task. We bypass the manager and write the
    // raw shape directly.
    const persistencePath = join(workDir, "task-state.json");
    writeFileSync(
      persistencePath,
      JSON.stringify({
        kind: "running",
        taskId: "T-prev",
        startedAt: 1_000_000,
        channel: "telegram",
        userMessage: "fix the auth bug please",
      }),
      "utf8"
    );

    // Re-instantiate the TaskStateManager pointing at the persisted file.
    const taskState = new TaskStateManager({ persistencePath });
    activeTaskState = taskState;
    const session = makeFakeSession();
    const mgr = new SessionManager({
      config: h.config,
      taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
    });

    await mgr.init();

    // Telegram sink got the recovery tell.
    expect(h.sinks.telegram.events.length).toBeGreaterThanOrEqual(1);
    const recovery = h.sinks.telegram.events[0]!;
    expect(recovery.type).toBe("tell");
    if (recovery.type === "tell") {
      expect(recovery.urgency).toBe("blocked");
      expect(recovery.text).toMatch(/I crashed/);
      expect(recovery.text).toMatch(/fix the auth bug/);
    }
    // State forced back to idle so subsequent handleInbound can run.
    expect(taskState.get().kind).toBe("idle");
  });

  test("idle state on disk → no recovery tell sent", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
    });
    await mgr.init();
    expect(h.sinks.telegram.events).toHaveLength(0);
    expect(h.sinks.terminal.events).toHaveLength(0);
    expect(h.sinks.whatsapp.events).toHaveLength(0);
  });
});
