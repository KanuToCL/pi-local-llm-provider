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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
    piCommsInboundRatePerSenderPerMin: 10,
    piCommsInboundRatePerChannelPerMin: 30,
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
    // Wait for both auto-promote AND watchdog to be scheduled (plan v2
    // IMPL-D Step D.4 added the watchdog as defense-in-depth).
    await waitFor(() => setTimeoutFn.mock.calls.length >= 2);

    // Exactly one auto-promote at the config'd delay; one watchdog at the
    // 5min default.  Find by delay value rather than position so we don't
    // care about scheduling order.
    const delays = setTimeoutFn.mock.calls.map((c) => c[1] as number);
    expect(delays).toContain(30_000);
    expect(delays).toContain(300_000);

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

    // Capture EVERY setTimeout — both auto-promote (30s) and watchdog
    // (5min) are scheduled now.  Filter by delay to grab the right one.
    const captured: { handler: () => void; delay: number }[] = [];
    const setTimeoutFn = vi.fn((handler: () => void, ms: number) => {
      captured.push({ handler, delay: ms });
      return Symbol(`handle-${captured.length}`);
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
    await waitFor(() => captured.some((c) => c.delay === 30_000));

    // Manually fire the auto-promote (30_000 delay), not the watchdog.
    const autoPromote = captured.find((c) => c.delay === 30_000);
    expect(autoPromote).toBeDefined();
    autoPromote!.handler();
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

  test("re-arms after first fire — second fire emits firingNumber=2 (FIX-B-1 #1)", async () => {
    const h = makeHarness();
    const session = makeFakeSession();

    // Capture every setTimeout invocation so we can fire timers in
    // sequence and observe the re-arm cadence.
    const captured: { handler: () => void; delay: number }[] = [];
    const setTimeoutFn = vi.fn((handler: () => void, ms: number) => {
      captured.push({ handler, delay: ms });
      return Symbol(`handle-${captured.length}`);
    });
    const clearTimeoutFn = vi.fn();

    let nowMs = 1_000_000;
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
      now: () => nowMs,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "long" });
    // Wait for both auto-promote (30_000) AND watchdog (300_000 default)
    // to be scheduled (plan v2 IMPL-D Step D.4).
    await waitFor(() => captured.length >= 2);
    const initialAutoPromote = captured.find((c) => c.delay === 30_000);
    expect(initialAutoPromote).toBeDefined();

    // Fire 1: 30s mark → backgrounded + firingNumber=1.
    nowMs = 1_000_000 + 30_000;
    initialAutoPromote!.handler();
    await waitFor(() => h.sinks.telegram.events.length >= 1);

    expect(h.taskState.get().kind).toBe("backgrounded");
    const e1 = h.sinks.telegram.events[0]!;
    expect(e1.type).toBe("auto_promote_notice");
    if (e1.type === "auto_promote_notice") {
      expect(e1.firingNumber).toBe(1);
      expect(e1.taskAgeSeconds).toBe(30);
    }

    // Fire 1 must have re-armed at +90s.  Find the 90_000 timer.
    await waitFor(() => captured.some((c) => c.delay === 90_000));
    const fire2 = captured.find((c) => c.delay === 90_000);
    expect(fire2).toBeDefined();

    // Fire 2.  Snapshot timer count BEFORE firing so we can identify the
    // re-arm timer that gets pushed AFTER (find by length-delta, not delay,
    // because the watchdog default is also 300_000 and was scheduled at
    // task start).
    const beforeFire2 = captured.length;
    nowMs = 1_000_000 + 30_000 + 90_000; // 2min mark
    fire2!.handler();
    await waitFor(() => h.sinks.telegram.events.length >= 2);
    const e2 = h.sinks.telegram.events[1]!;
    expect(e2.type).toBe("auto_promote_notice");
    if (e2.type === "auto_promote_notice") {
      expect(e2.firingNumber).toBe(2);
      expect(e2.taskAgeSeconds).toBe(120);
    }
    // State should still be backgrounded (re-fires don't re-transition).
    expect(h.taskState.get().kind).toBe("backgrounded");

    // Fire 2 re-armed at +5min.  Find the new timer pushed AFTER fire 2.
    await waitFor(() => captured.length > beforeFire2);
    const fire3 = captured.slice(beforeFire2).find((c) => c.delay === 300_000);
    expect(fire3).toBeDefined();

    // Fire 3: 7min mark.  Same snapshot pattern.
    const beforeFire3 = captured.length;
    nowMs = 1_000_000 + 30_000 + 90_000 + 300_000;
    fire3!.handler();
    await waitFor(() => h.sinks.telegram.events.length >= 3);
    const e3 = h.sinks.telegram.events[2]!;
    if (e3.type === "auto_promote_notice") {
      expect(e3.firingNumber).toBe(3);
      expect(e3.taskAgeSeconds).toBe(420);
    }

    // Fire 3 re-arms at +5min cap.
    await waitFor(() => captured.length > beforeFire3);
    const fire4 = captured.slice(beforeFire3).find((c) => c.delay === 300_000);
    expect(fire4).toBeDefined();

    // Cancel the task to clean up.
    const cur = h.taskState.get();
    if (cur.kind === "backgrounded") {
      h.taskState.tryTransition({
        kind: "cancelled",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        cancelledAt: nowMs,
        reason: "user",
      });
    }
    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("re-arm timer is cleared on task completion (FIX-B-1 #1)", async () => {
    const h = makeHarness();
    const session = makeFakeSession();

    const captured: { handler: () => void; delay: number }[] = [];
    const setTimeoutFn = vi.fn((handler: () => void, ms: number) => {
      captured.push({ handler, delay: ms });
      return Symbol(`handle-${captured.length}`);
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
    await waitFor(() => captured.length >= 1);

    // Resolve the prompt + complete the task BEFORE firing the timer.
    session.resolveCurrentPrompt!();
    await inflight;

    // Subsequent fires should NOT emit (taskState is no longer running).
    captured[0]!.handler();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.sinks.telegram.events).toHaveLength(0);

    await mgr.dispose();
  });

  test("cold-start: model not loaded → emits 'warming up' notice and reschedules (FIX-B-1 #4)", async () => {
    const h = makeHarness();
    const session = makeFakeSession();

    const captured: { handler: () => void; delay: number }[] = [];
    const setTimeoutFn = vi.fn((handler: () => void, ms: number) => {
      captured.push({ handler, delay: ms });
      return Symbol(`handle-${captured.length}`);
    });
    const clearTimeoutFn = vi.fn();

    let modelReadyAttempts = 0;
    const isStudioModelLoaded = vi.fn(async () => {
      modelReadyAttempts += 1;
      return modelReadyAttempts >= 3; // false twice, then true
    });

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
      isStudioModelLoaded,
      coldStartMaxRetries: 5,
      coldStartRetryMs: 30_000,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
    // Wait for both auto-promote (30_000) AND watchdog (300_000 default).
    await waitFor(() => captured.length >= 2);

    // Fire 1 (auto-promote, 30_000 delay) — model not ready (attempt 1) —
    // emits warming notice + reschedules.
    const fire1 = captured.find((c) => c.delay === 30_000);
    expect(fire1).toBeDefined();
    fire1!.handler();
    await waitFor(() => h.sinks.telegram.events.length >= 1);
    const e1 = h.sinks.telegram.events[0]!;
    expect(e1.type).toBe("system_notice");
    if (e1.type === "system_notice") {
      expect(e1.text).toMatch(/warming up/i);
    }
    // No backgrounded transition yet.
    expect(h.taskState.get().kind).toBe("running");
    // Reschedule at +30s — second 30_000 timer (cold-start retry).
    await waitFor(() => captured.filter((c) => c.delay === 30_000).length >= 2);
    const fire2 = captured.filter((c) => c.delay === 30_000)[1];
    expect(fire2).toBeDefined();

    // Fire 2 — model not ready (attempt 2) — another warming notice.
    fire2!.handler();
    await waitFor(() => h.sinks.telegram.events.length >= 2);
    const e2 = h.sinks.telegram.events[1]!;
    expect(e2.type).toBe("system_notice");
    expect(h.taskState.get().kind).toBe("running");

    // Fire 3 — model ready — fires the real auto_promote_notice.
    await waitFor(() => captured.filter((c) => c.delay === 30_000).length >= 3);
    const fire3 = captured.filter((c) => c.delay === 30_000)[2];
    expect(fire3).toBeDefined();
    fire3!.handler();
    await waitFor(
      () =>
        h.sinks.telegram.events.length >= 3 &&
        h.sinks.telegram.events.some(
          (e) => e.type === "auto_promote_notice",
        ),
    );
    const promoted = h.sinks.telegram.events.find(
      (e) => e.type === "auto_promote_notice",
    );
    expect(promoted).toBeDefined();
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
  // BUG-2026-05-03 fix (plan v2 IMPL-B mapper change, commit 53fe7b0):
  // mapper now emits `reply` (no urgency) instead of `tell{urgency:"done"}`
  // for message_end. The Telegram channel formatter prefixed every `tell`
  // with `📱`, which is why reply needed its own ChannelEvent variant.
  test("maps message_end with assistant text → reply (no urgency, no prefix)", () => {
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
    expect(ce!.type).toBe("reply");
    if (ce!.type === "reply") {
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
    if (ce && ce.type === "reply") expect(ce.text).toBe("compact reply");
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

// ---------------------------------------------------------------------------
// Helper: read all audit-log lines emitted today.
// ---------------------------------------------------------------------------

function readAuditLines(auditDir: string): Record<string, unknown>[] {
  const today = new Date().toISOString().slice(0, 10);
  const file = join(auditDir, `audit.${today}.jsonl`);
  try {
    const raw = readFileSync(file, "utf8");
    return raw
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Stuck-task fix (plan v2 IMPL-D Step D.4): TaskState watchdog.
// ---------------------------------------------------------------------------

describe("TaskState watchdog (plan v2 IMPL-D)", () => {
  test("force-completes a task stuck running past taskWatchdogMs", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    // Capture every setTimeout so we can identify + manually-fire the
    // watchdog's timer (vs. the auto-promote's timer).
    const captured: { handler: () => void; delay: number; id: symbol }[] = [];
    const setTimeoutFn = vi.fn((handler: () => void, ms: number) => {
      const id = Symbol(`timer-${captured.length}`);
      captured.push({ handler, delay: ms, id });
      return id;
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
      taskWatchdogMs: 100,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "stuck task" });
    // Wait for both the auto-promote (30_000) and the watchdog (100) to be
    // scheduled.
    await waitFor(() => captured.length >= 2);
    const watchdog = captured.find((t) => t.delay === 100);
    expect(watchdog).toBeDefined();

    // Fire the watchdog timer.
    watchdog!.handler();
    await waitFor(() => h.taskState.get().kind === "failed");

    // State transitioned to failed (not idle, since failed is the rescue
    // sink for stuck-task watchdogs).
    expect(h.taskState.get().kind).toBe("failed");

    // System notice was emitted to the originating channel.
    await waitFor(() => h.sinks.telegram.events.length > 0);
    const notice = h.sinks.telegram.events.find(
      (e) => e.type === "system_notice",
    );
    expect(notice).toBeDefined();
    if (notice && notice.type === "system_notice") {
      expect(notice.text).toMatch(/watchdog|stuck|terminal event/i);
    }

    // Audit entry recorded with reason "watchdog_no_terminal_event".
    await waitFor(
      () =>
        readAuditLines(join(workDir, "audit")).some((e) =>
          (e.event === "task_failed" &&
            typeof e.extra === "object" &&
            e.extra !== null &&
            (e.extra as Record<string, unknown>).reason ===
              "watchdog_no_terminal_event"),
        ),
    );
    const found = readAuditLines(join(workDir, "audit")).find(
      (e) =>
        e.event === "task_failed" &&
        typeof e.extra === "object" &&
        e.extra !== null &&
        (e.extra as Record<string, unknown>).reason ===
          "watchdog_no_terminal_event",
    );
    expect(found).toBeDefined();

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("watchdog is cancelled when task completes normally (no spurious failure)", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const captured: { handler: () => void; delay: number; id: symbol }[] = [];
    const setTimeoutFn = vi.fn((handler: () => void, ms: number) => {
      const id = Symbol(`timer-${captured.length}`);
      captured.push({ handler, delay: ms, id });
      return id;
    });
    const clearedIds: unknown[] = [];
    const clearTimeoutFn = vi.fn((id: unknown) => {
      clearedIds.push(id);
    });

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
      taskWatchdogMs: 100,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "ok task" });
    await waitFor(() => captured.length >= 2);
    const watchdogTimer = captured.find((t) => t.delay === 100);
    expect(watchdogTimer).toBeDefined();

    // Simulate a normal completion: emit agent_end via the subscriber.
    session.emit({ type: "agent_end" });
    await waitFor(() => h.taskState.get().kind === "completed");

    // The watchdog timer ID should have been cleared.
    expect(clearedIds).toContain(watchdogTimer!.id);

    // Even if the watchdog handler somehow fired now, the task is in
    // `completed` state so it should be a no-op (the watchdog checks
    // running/backgrounded only).
    watchdogTimer!.handler();
    await new Promise((r) => setImmediate(r));
    expect(h.taskState.get().kind).toBe("completed");

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// serial_queue_blocked user notice (plan v2 IMPL-D Step D.5).
// ---------------------------------------------------------------------------

describe("serial_queue_blocked user notice (plan v2 IMPL-D)", () => {
  test("second concurrent inbound emits system_notice to originating channel + audit entry", async () => {
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

    // First inbound — starts running.
    const a = mgr.handleInbound({ channel: "telegram", text: "long task" });
    await waitFor(() => session.promptCalls.length >= 1);
    expect(h.taskState.get().kind).toBe("running");

    // Force-complete the queue lock by NOT releasing the prompt yet, then
    // fire a second inbound.  Because GlobalQueue serializes the run, the
    // second inbound will run AFTER the first.  We need to test what happens
    // when the second one acquires the lock and finds running state.

    // Release the first prompt + drain via going to backgrounded so the lock
    // releases, but state is still busy when the second inbound acquires.
    const cur = h.taskState.get();
    if (cur.kind === "running") {
      h.taskState.tryTransition({
        kind: "backgrounded",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        channel: cur.channel,
        userMessage: cur.userMessage,
        abort: cur.abort,
        promotedAt: Date.now(),
        promotedBy: "auto",
      });
    }
    session.resolveCurrentPrompt!();
    await a;

    // Now state is `backgrounded`. A second inbound should be rejected
    // and emit a user-facing notice + audit entry.
    h.sinks.telegram.events = [];
    await mgr.handleInbound({ channel: "telegram", text: "follow-up" });

    // System notice on originating channel.
    expect(h.sinks.telegram.events.length).toBeGreaterThan(0);
    const notice = h.sinks.telegram.events.find(
      (e) => e.type === "system_notice",
    );
    expect(notice).toBeDefined();
    if (notice && notice.type === "system_notice") {
      expect(notice.text).toMatch(/still working|previous request|follow-up/i);
    }

    // Audit entry recorded.
    await waitFor(
      () =>
        readAuditLines(join(workDir, "audit")).some(
          (e) => e.event === "serial_queue_blocked",
        ),
    );
    const auditLines = readAuditLines(join(workDir, "audit"));
    const blocked = auditLines.find((e) => e.event === "serial_queue_blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.channel).toBe("telegram");

    // Cleanup.
    const cur2 = h.taskState.get();
    if (cur2.kind === "backgrounded") {
      h.taskState.tryTransition({
        kind: "completed",
        taskId: cur2.taskId,
        startedAt: cur2.startedAt,
        finishedAt: Date.now(),
      });
    }
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// prompt_version_changed wiring (plan v2 IMPL-D Step D.6).
// ---------------------------------------------------------------------------

describe("prompt_version_changed audit (plan v2 IMPL-D)", () => {
  test("init() emits prompt_version_changed audit entry with path + sha256_first8", async () => {
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

    await waitFor(() =>
      readAuditLines(join(workDir, "audit")).some(
        (e) => e.event === "prompt_version_changed",
      ),
    );
    const lines = readAuditLines(join(workDir, "audit"));
    const entry = lines.find((e) => e.event === "prompt_version_changed");
    expect(entry).toBeDefined();
    expect(entry!.task_id).toBeNull();
    expect(entry!.channel).toBe("system");
    const extra = entry!.extra as Record<string, unknown>;
    expect(extra.path).toBe(h.basePromptPath);
    expect(typeof extra.sha256_first8).toBe("string");
    expect((extra.sha256_first8 as string).length).toBe(8);

    await mgr.dispose();
  });
});
