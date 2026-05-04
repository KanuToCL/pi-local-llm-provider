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
let activeAuditLog: AuditLog | null = null;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-session-"));
  activeTaskState = null;
  activeAuditLog = null;
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
  // Drain audit-log writeQueue too — IMPL-D added several fire-and-forget
  // audit appends (watchdog, prompt_version_changed, studio_model_swap) that
  // can land AFTER the test body finishes; rmSync racing them produces
  // ENOTEMPTY on macOS.
  if (activeAuditLog) {
    try {
      // The writeQueue is private; the cheapest drain is a no-op append +
      // wait. Cap at a few attempts so a wedged queue doesn't hang afterEach.
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setImmediate(r));
      }
    } catch {
      /* ignore */
    }
  }
  // rmSync with force: true is supposed to ignore ENOENT but NOT ENOTEMPTY;
  // retry briefly to absorb any final straggler write that lands during the
  // initial rm sweep.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(workDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setImmediate(r));
    }
  }
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

  const auditLog = new AuditLog({
    dir: join(workDir, "audit"),
    daemonStartTs: Date.now(),
  });
  activeAuditLog = auditLog;
  return {
    config: makeBaseConfig(),
    taskState,
    pendingConfirms: new PendingConfirmsRegistry(),
    sandboxPolicy: new SandboxPolicy({
      jsonStore: new JsonStore<SandboxState>(join(workDir, "sandbox.json")),
    }),
    auditLog,
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
    // Use a generous maxAttempts because the audit-log write is queued
    // through a Promise chain + mkdir + appendFile, and under parallel
    // test-suite load the syscall latency adds up.
    let found: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      found = lines.find(
        (e) =>
          e.event === "task_failed" &&
          typeof e.extra === "object" &&
          e.extra !== null &&
          (e.extra as Record<string, unknown>).reason ===
            "watchdog_no_terminal_event",
      );
      return found !== undefined;
    }, 1000);
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

    // AUDIT-D NIT 9: defensive — ensure the watchdog did NOT emit a
    // user-facing notice when firing against an already-completed task.
    expect(
      h.sinks.telegram.events.filter((e) => e.type === "system_notice"),
    ).toHaveLength(0);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// markTaskCompleted idempotence (BLESS Adversarial NEW-3).
// ---------------------------------------------------------------------------

describe("markTaskCompleted idempotence (BLESS NEW-3)", () => {
  test("multiple message_end events for same task → side effects fire only once", async () => {
    const h = makeHarness();
    // Track sandboxPolicy.onTaskCompleted calls by spying on it.
    let sandboxCompleteCalls = 0;
    const realOnComplete = h.sandboxPolicy.onTaskCompleted.bind(h.sandboxPolicy);
    h.sandboxPolicy.onTaskCompleted = () => {
      sandboxCompleteCalls += 1;
      realOnComplete();
    };

    // Capture operator-log task_completed entries.
    const opCompletedEntries: Record<string, unknown>[] = [];
    const operatorLogger = {
      includeContent: false,
      preview: (s: string | undefined) => s,
      banner: () => {},
      info: (event: string, fields?: Record<string, unknown>) => {
        if (event === "task_completed") {
          opCompletedEntries.push((fields ?? {}) as Record<string, unknown>);
        }
      },
      debug: () => {},
      error: () => {},
    };

    const session = makeFakeSession();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      operatorLogger,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "task" });
    await waitFor(() => session.promptCalls.length > 0);

    // pi-mono streaming sometimes emits multiple message_end events for the
    // same turn (BLESS Adversarial NEW-3). Without the CAS gate, each call
    // would re-fire audit + operator log + sandboxPolicy.onTaskCompleted.
    const sandboxBaseline = sandboxCompleteCalls;
    session.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    session.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    session.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    await waitFor(() => h.taskState.get().kind === "completed");
    // Yield a couple turns so any (incorrect) double-fire would land.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // sandboxPolicy.onTaskCompleted called exactly once via markTaskCompleted
    // (NOTE: handleInbound's finally-block also calls it, but only AFTER
    // resolveCurrentPrompt resolves — at this point the prompt is still
    // pending, so the only path that increments is markTaskCompleted itself).
    expect(sandboxCompleteCalls - sandboxBaseline).toBe(1);

    // Operator log task_completed fired exactly once.
    expect(opCompletedEntries).toHaveLength(1);

    // Audit log task_completed fired exactly once.
    let auditCount = 0;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      auditCount = lines.filter((e) => e.event === "task_completed").length;
      return auditCount >= 1;
    }, 1000);
    // Keep yielding briefly so any spurious second append would land.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const finalLines = readAuditLines(join(workDir, "audit"));
    const finalCount = finalLines.filter((e) => e.event === "task_completed").length;
    expect(finalCount).toBe(1);

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
    let blocked: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      blocked = lines.find((e) => e.event === "serial_queue_blocked");
      return blocked !== undefined;
    }, 1000);
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

    let entry: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      entry = lines.find((e) => e.event === "prompt_version_changed");
      return entry !== undefined;
    }, 1000);
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

// ---------------------------------------------------------------------------
// Soft Studio model-swap detector (plan v2 IMPL-D Step D.7).
// ---------------------------------------------------------------------------

describe("checkForStudioModelSwap (plan v2 IMPL-D)", () => {
  /**
   * Helper: build a SessionManager wired with the soft-swap probe + fake
   * `now()` so per-channel cooldown can be tested without real wall-clock
   * waits.  Returns the manager + control surfaces.
   */
  async function buildSwapHarness(opts: {
    h: Harness;
    coldStartModelId: string | null;
    probeReturns: ReadonlyArray<readonly string[] | null>;
    probeError?: Error;
  }): Promise<{
    mgr: SessionManager;
    session: FakeSession;
    nowMs: { value: number };
    probeCalls: number;
  }> {
    const session = makeFakeSession();
    const nowMs = { value: 1_000_000 };
    let probeCalls = 0;
    const probe = vi.fn(async (): Promise<readonly string[] | null> => {
      const idx = Math.min(probeCalls, opts.probeReturns.length - 1);
      probeCalls += 1;
      if (opts.probeError && idx === 0) throw opts.probeError;
      return opts.probeReturns[idx] ?? null;
    });
    const mgr = new SessionManager({
      config: opts.h.config,
      taskState: opts.h.taskState,
      pendingConfirms: opts.h.pendingConfirms,
      sandboxPolicy: opts.h.sandboxPolicy,
      auditLog: opts.h.auditLog,
      sinks: opts.h.sinks,
      basePromptPath: opts.h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
      coldStartModelId: opts.coldStartModelId,
      getStudioLoadedModelIds: probe,
      now: () => nowMs.value,
    });
    await mgr.init();
    return {
      mgr,
      session,
      nowMs,
      get probeCalls() {
        return probeCalls;
      },
    } as {
      mgr: SessionManager;
      session: FakeSession;
      nowMs: { value: number };
      probeCalls: number;
    };
  }

  test("same model loaded as boot → no notice emitted", async () => {
    const h = makeHarness();
    const { mgr, session } = await buildSwapHarness({
      h,
      coldStartModelId: "modelA",
      probeReturns: [["modelA"]],
    });
    h.sinks.telegram.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    // Yield so the fire-and-forget probe + post-probe emission settles.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const swapNotices = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" &&
        /loaded model changed|Studio has no model/i.test(e.text),
    );
    expect(swapNotices).toHaveLength(0);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("swap to new model → emits notice + audit entry + operator log", async () => {
    const h = makeHarness();
    const operatorEntries: { event: string; fields: Record<string, unknown> }[] =
      [];
    const operatorLogger = {
      includeContent: false,
      preview: (s: string | undefined) => s,
      banner: () => {},
      info: (event: string, fields?: Record<string, unknown>) => {
        operatorEntries.push({ event, fields: (fields ?? {}) as Record<string, unknown> });
      },
      debug: () => {},
      error: () => {},
    };
    const session = makeFakeSession();
    const probe = vi.fn(async (): Promise<readonly string[] | null> => ["modelB"]);
    const nowMs = 1_000_000;
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      operatorLogger,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
      coldStartModelId: "modelA",
      getStudioLoadedModelIds: probe,
      now: () => nowMs,
    });
    await mgr.init();
    h.sinks.telegram.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    await waitFor(
      () =>
        h.sinks.telegram.events.some(
          (e) =>
            e.type === "system_notice" && /loaded model changed/i.test(e.text),
        ),
      400,
    );

    const notice = h.sinks.telegram.events.find(
      (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
    );
    expect(notice).toBeDefined();
    if (notice && notice.type === "system_notice") {
      expect(notice.text).toContain("modelA");
      expect(notice.text).toContain("modelB");
      expect(notice.level).toBe("warn");
    }

    // Audit entry recorded.
    let swap: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      swap = lines.find((e) => e.event === "studio_model_swap_detected");
      return swap !== undefined;
    }, 1000);
    expect(swap).toBeDefined();
    expect(swap!.channel).toBe("telegram");
    const extra = swap!.extra as Record<string, unknown>;
    expect(extra.cold_start_model_id).toBe("modelA");
    expect(extra.current_model_id).toBe("modelB");

    // Operator log entry recorded.
    const opEntry = operatorEntries.find(
      (e) => e.event === "studio_model_swap_detected",
    );
    expect(opEntry).toBeDefined();
    expect(opEntry!.fields.cold_start_model_id).toBe("modelA");
    expect(opEntry!.fields.current_model_id).toBe("modelB");

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("one-shot suppression: same swap-target on next inbound → no second notice", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const probe = vi.fn(async (): Promise<readonly string[] | null> => ["modelB"]);
    const nowMs = { value: 1_000_000 };
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
      coldStartModelId: "modelA",
      getStudioLoadedModelIds: probe,
      now: () => nowMs.value,
    });
    await mgr.init();
    h.sinks.telegram.events = [];

    // First inbound → notice fires.
    const a = mgr.handleInbound({ channel: "telegram", text: "first" });
    await waitFor(() => session.promptCalls.length > 0);
    await waitFor(
      () =>
        h.sinks.telegram.events.some(
          (e) =>
            e.type === "system_notice" && /loaded model changed/i.test(e.text),
        ),
      400,
    );
    expect(
      h.sinks.telegram.events.filter(
        (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
      ),
    ).toHaveLength(1);

    // Drain to idle so a second inbound can run.
    const cur = h.taskState.get();
    if (cur.kind === "running" || cur.kind === "backgrounded") {
      h.taskState.tryTransition({
        kind: "completed",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        finishedAt: nowMs.value,
      });
      h.taskState.tryTransition({ kind: "idle" });
    }
    session.resolveCurrentPrompt!();
    await a;

    // Advance time PAST the cooldown so we're testing one-shot, not cooldown.
    nowMs.value += 120_000;

    // Second inbound — same swap target (modelB).  Should NOT re-emit.
    const beforeCount = h.sinks.telegram.events.filter(
      (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
    ).length;
    const b = mgr.handleInbound({ channel: "telegram", text: "second" });
    await waitFor(() => session.promptCalls.length > 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const afterCount = h.sinks.telegram.events.filter(
      (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
    ).length;
    expect(afterCount).toBe(beforeCount);

    session.resolveCurrentPrompt!();
    await b;
    await mgr.dispose();
  });

  test("multi-load: original still in loaded[] → no notice", async () => {
    const h = makeHarness();
    // Studio reports BOTH the original modelA and the new modelB loaded.
    // Since modelA is still there, the daemon's session is fine — no notice.
    const { mgr, session } = await buildSwapHarness({
      h,
      coldStartModelId: "modelA",
      probeReturns: [["modelA", "modelB"]],
    });
    h.sinks.telegram.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const swapNotices = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" && /loaded model changed/i.test(e.text),
    );
    expect(swapNotices).toHaveLength(0);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("studio-empty: loaded.length === 0 → distinct 'has no model' notice", async () => {
    const h = makeHarness();
    const { mgr, session } = await buildSwapHarness({
      h,
      coldStartModelId: "modelA",
      probeReturns: [[]],
    });
    h.sinks.telegram.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    await waitFor(
      () =>
        h.sinks.telegram.events.some(
          (e) =>
            e.type === "system_notice" && /Studio has no model/i.test(e.text),
        ),
      400,
    );

    const empty = h.sinks.telegram.events.find(
      (e) => e.type === "system_notice" && /Studio has no model/i.test(e.text),
    );
    expect(empty).toBeDefined();
    if (empty && empty.type === "system_notice") {
      expect(empty.level).toBe("warn");
    }

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("per-channel cooldown: second notice within 60s suppressed (different model)", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    let callIdx = 0;
    const probe = vi.fn(async (): Promise<readonly string[] | null> => {
      const seq: ReadonlyArray<readonly string[]> = [["modelB"], ["modelC"]];
      const out = seq[Math.min(callIdx, seq.length - 1)];
      callIdx += 1;
      return out;
    });
    const nowMs = { value: 1_000_000 };
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
      coldStartModelId: "modelA",
      getStudioLoadedModelIds: probe,
      now: () => nowMs.value,
    });
    await mgr.init();
    h.sinks.telegram.events = [];

    // First inbound → notice for modelB.
    const a = mgr.handleInbound({ channel: "telegram", text: "first" });
    await waitFor(() => session.promptCalls.length > 0);
    await waitFor(
      () =>
        h.sinks.telegram.events.some(
          (e) =>
            e.type === "system_notice" && /loaded model changed/i.test(e.text),
        ),
      400,
    );
    expect(
      h.sinks.telegram.events.filter(
        (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
      ),
    ).toHaveLength(1);

    // Drain to idle.
    const cur = h.taskState.get();
    if (cur.kind === "running" || cur.kind === "backgrounded") {
      h.taskState.tryTransition({
        kind: "completed",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        finishedAt: nowMs.value,
      });
      h.taskState.tryTransition({ kind: "idle" });
    }
    session.resolveCurrentPrompt!();
    await a;

    // Stay WITHIN cooldown (advance only 30s, not 60s).
    nowMs.value += 30_000;

    // Second inbound → probe returns modelC (different from modelB) — but
    // cooldown should suppress.
    const beforeCount = h.sinks.telegram.events.filter(
      (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
    ).length;
    const b = mgr.handleInbound({ channel: "telegram", text: "second" });
    await waitFor(() => session.promptCalls.length > 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const afterCount = h.sinks.telegram.events.filter(
      (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
    ).length;
    expect(afterCount).toBe(beforeCount);

    session.resolveCurrentPrompt!();
    await b;
    await mgr.dispose();
  });

  test("post-abort gate: cancelled state when probe resolves → no notice", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    let resolveProbe: ((v: readonly string[] | null) => void) | null = null;
    const probe = vi.fn(async (): Promise<readonly string[] | null> => {
      return new Promise<readonly string[] | null>((r) => {
        resolveProbe = r;
      });
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
      coldStartModelId: "modelA",
      getStudioLoadedModelIds: probe,
    });
    await mgr.init();
    h.sinks.telegram.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    await waitFor(() => resolveProbe !== null);

    // Cancel the task BEFORE the probe resolves.
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

    // NOW resolve the probe with a swap-detected payload.
    resolveProbe!(["modelB"]);
    // Yield so the post-abort-gated emission would run if it weren't suppressed.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const swapNotices = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" && /loaded model changed/i.test(e.text),
    );
    expect(swapNotices).toHaveLength(0);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("probe error → swallowed, no notice, no crash", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const probe = vi.fn(async (): Promise<readonly string[] | null> => {
      throw new Error("network down");
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
      coldStartModelId: "modelA",
      getStudioLoadedModelIds: probe,
    });
    await mgr.init();
    h.sinks.telegram.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const swapNotices = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" && /loaded model changed/i.test(e.text),
    );
    expect(swapNotices).toHaveLength(0);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("no coldStartModelId / no probe → fire-and-forget no-op", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    // No getStudioLoadedModelIds, no coldStartModelId.
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
    h.sinks.telegram.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    await new Promise((r) => setImmediate(r));

    const swapNotices = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" && /loaded model changed/i.test(e.text),
    );
    expect(swapNotices).toHaveLength(0);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("swap notice mirrors to terminal sink when origin is non-terminal", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const probe = vi.fn(async (): Promise<readonly string[] | null> => ["modelB"]);
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
      coldStartModelId: "modelA",
      getStudioLoadedModelIds: probe,
    });
    await mgr.init();
    h.sinks.telegram.events = [];
    h.sinks.terminal.events = [];

    const inflight = mgr.handleInbound({ channel: "telegram", text: "hi" });
    await waitFor(() => session.promptCalls.length > 0);
    await waitFor(
      () =>
        h.sinks.telegram.events.some(
          (e) =>
            e.type === "system_notice" && /loaded model changed/i.test(e.text),
        ),
      400,
    );

    // Notice should land on BOTH telegram (origin) AND terminal (mirror).
    const onTel = h.sinks.telegram.events.find(
      (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
    );
    const onTerm = h.sinks.terminal.events.find(
      (e) => e.type === "system_notice" && /loaded model changed/i.test(e.text),
    );
    expect(onTel).toBeDefined();
    expect(onTerm).toBeDefined();

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// task_completed ChannelEvent rewrite (BLESS S4 — Architect + UX +
// Integration convergence).  When a `backgrounded` task transitions to
// `completed`, the user must see a `task_completed` ChannelEvent (which the
// channel formatters render as `pi: ✅ done.`) — NOT a plain `reply` (which
// is indistinguishable from a fresh chat reply).
// ---------------------------------------------------------------------------

describe("backgrounded → completed task_completed rewrite (BLESS S4)", () => {
  test("backgrounded task → reply rewritten to task_completed ChannelEvent", async () => {
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

    const inflight = mgr.handleInbound({ channel: "telegram", text: "long task" });
    await waitFor(() => session.promptCalls.length > 0);

    // Manually drive the task to backgrounded (simulating auto-promote
    // having fired).  This is the precondition for the rewrite.
    const cur = h.taskState.get();
    expect(cur.kind).toBe("running");
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
    const taskIdAtBg = (h.taskState.get() as { taskId: string }).taskId;

    h.sinks.telegram.events = [];

    // pi-mono emits message_end with the assistant's final reply.
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "all done with that task" }],
      },
    });
    await waitFor(() => h.sinks.telegram.events.length > 0);

    // The ChannelEvent that landed on Telegram MUST be task_completed, NOT
    // reply.  This is what the channel formatter renders as `pi: ✅ done.`.
    const evt = h.sinks.telegram.events[0]!;
    expect(evt.type).toBe("task_completed");
    if (evt.type === "task_completed") {
      expect(evt.taskId).toBe(taskIdAtBg);
      expect(evt.finalMessage).toBe("all done with that task");
    }

    // markTaskCompleted MUST still fire — task should be `completed`.
    expect(h.taskState.get().kind).toBe("completed");

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("running (not backgrounded) task → reply unchanged (no rewrite)", async () => {
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

    const inflight = mgr.handleInbound({ channel: "telegram", text: "quick" });
    await waitFor(() => session.promptCalls.length > 0);
    expect(h.taskState.get().kind).toBe("running");

    h.sinks.telegram.events = [];

    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    });
    await waitFor(() => h.sinks.telegram.events.length > 0);

    // Task was running (not backgrounded), so the rewrite must NOT fire —
    // the channel sees a plain reply.
    const evt = h.sinks.telegram.events[0]!;
    expect(evt.type).toBe("reply");

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// serial_queue_blocked notice cooldown (BLESS PE Skeptic IMPORTANT 3 + UX
// IMPORTANT 1).  Spam follow-ups (30 messages) must NOT trigger 30 user-
// facing system_notices (Telegram 429 risk), but the audit log row should
// still fire per drop (forensic value preserved).
// ---------------------------------------------------------------------------

describe("serial_queue_blocked cooldown (BLESS PE Skeptic + UX)", () => {
  test("second drop within 30s suppressed; audit row still fires", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const nowMs = { value: 1_000_000 };
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
      now: () => nowMs.value,
    });
    await mgr.init();

    // Move to backgrounded so the queue lock releases but state is still busy.
    const a = mgr.handleInbound({ channel: "telegram", text: "long" });
    await waitFor(() => session.promptCalls.length > 0);
    const cur = h.taskState.get();
    if (cur.kind === "running") {
      h.taskState.tryTransition({
        kind: "backgrounded",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        channel: cur.channel,
        userMessage: cur.userMessage,
        abort: cur.abort,
        promotedAt: nowMs.value,
        promotedBy: "auto",
      });
    }
    session.resolveCurrentPrompt!();
    await a;

    h.sinks.telegram.events = [];

    // First dropped follow-up — emits notice + audit row.
    await mgr.handleInbound({ channel: "telegram", text: "drop 1" });
    const noticesAfterFirst = h.sinks.telegram.events.filter(
      (e) => e.type === "system_notice" && /still working|previous request/i.test(e.text),
    );
    expect(noticesAfterFirst).toHaveLength(1);

    // Second dropped follow-up at +5s (within the 30s cooldown) — audit row
    // STILL fires, but NO new user-facing notice.
    nowMs.value += 5_000;
    await mgr.handleInbound({ channel: "telegram", text: "drop 2" });
    const noticesAfterSecond = h.sinks.telegram.events.filter(
      (e) => e.type === "system_notice" && /still working|previous request/i.test(e.text),
    );
    expect(noticesAfterSecond).toHaveLength(1); // STILL 1 — suppressed.

    // Third dropped follow-up AFTER cooldown (advance past 30s from FIRST) —
    // notice fires again.
    nowMs.value += 30_000; // total +35s from first
    await mgr.handleInbound({ channel: "telegram", text: "drop 3" });
    const noticesAfterThird = h.sinks.telegram.events.filter(
      (e) => e.type === "system_notice" && /still working|previous request/i.test(e.text),
    );
    expect(noticesAfterThird).toHaveLength(2);

    // Audit log: should have THREE serial_queue_blocked rows (one per drop).
    let blockedCount = 0;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      blockedCount = lines.filter((e) => e.event === "serial_queue_blocked").length;
      return blockedCount >= 3;
    }, 1000);
    expect(blockedCount).toBe(3);

    // Cleanup.
    const cur2 = h.taskState.get();
    if (cur2.kind === "backgrounded") {
      h.taskState.tryTransition({
        kind: "completed",
        taskId: cur2.taskId,
        startedAt: cur2.startedAt,
        finishedAt: nowMs.value,
      });
    }
    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Watchdog reset on tool_execution_start (BLESS Adversarial NEW-4 + PE).
// The 5min watchdog default kills legit long tasks (compile kernel, full
// vitest suite, transcribe 30min audio).  Each tool_execution_start event
// from pi-mono shows life and re-arms the watchdog.
// ---------------------------------------------------------------------------

describe("watchdog reset on tool_execution_start (BLESS NEW-4)", () => {
  test("tool_execution_start re-arms timer; original deadline extended", async () => {
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

    const inflight = mgr.handleInbound({ channel: "telegram", text: "long task" });
    // Wait for both auto-promote (30_000) and watchdog (100) to be scheduled.
    await waitFor(() => captured.length >= 2);
    const initialWatchdog = captured.find((t) => t.delay === 100);
    expect(initialWatchdog).toBeDefined();
    const initialWatchdogId = initialWatchdog!.id;

    // pi-mono emits tool_execution_start (life signal).
    session.emit({ type: "tool_execution_start" });
    await new Promise((r) => setImmediate(r));

    // The OLD watchdog timer was cleared, and a NEW one armed.
    expect(clearedIds).toContain(initialWatchdogId);
    const newWatchdogTimers = captured.filter((t) => t.delay === 100);
    expect(newWatchdogTimers.length).toBeGreaterThanOrEqual(2);

    // Multiple tool_execution_start events keep extending.
    session.emit({ type: "tool_execution_start" });
    await new Promise((r) => setImmediate(r));
    const afterTwo = captured.filter((t) => t.delay === 100).length;
    expect(afterTwo).toBeGreaterThanOrEqual(3);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });

  test("tool_execution_start when no task running → no-op", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
    const captured: { handler: () => void; delay: number; id: symbol }[] = [];
    const setTimeoutFn = vi.fn((handler: () => void, ms: number) => {
      const id = Symbol(`timer-${captured.length}`);
      captured.push({ handler, delay: ms, id });
      return id;
    });
    const clearedIds: unknown[] = [];
    const clearTimeoutFn = vi.fn((id: unknown) => clearedIds.push(id));

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

    expect(h.taskState.get().kind).toBe("idle");
    const beforeCount = captured.length;
    const beforeClearedCount = clearedIds.length;

    // No task running — emit a stray tool_execution_start.  Should be a no-op.
    session.emit({ type: "tool_execution_start" });
    await new Promise((r) => setImmediate(r));

    expect(captured.length).toBe(beforeCount);
    expect(clearedIds.length).toBe(beforeClearedCount);

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Mapper logger task_id injection (BLESS Observability N1).  The mapper's
// framework_reply_dropped / framework_reply_emitted log entries must carry
// task_id so forensic correlation across audit + operator log + per-task
// lifecycle events is seamless.
// ---------------------------------------------------------------------------

describe("mapper logger task_id injection (BLESS Obs N1)", () => {
  test("mapper logger injects task_id into framework_reply_emitted", async () => {
    const h = makeHarness();
    const debugEntries: { event: string; fields: Record<string, unknown> }[] = [];
    const operatorLogger = {
      includeContent: true,
      preview: (s: string | undefined) => s,
      banner: () => {},
      info: () => {},
      debug: (event: string, fields?: Record<string, unknown>) => {
        debugEntries.push({ event, fields: (fields ?? {}) as Record<string, unknown> });
      },
      error: () => {},
    };

    const session = makeFakeSession();
    const mgr = new SessionManager({
      config: h.config,
      taskState: h.taskState,
      pendingConfirms: h.pendingConfirms,
      sandboxPolicy: h.sandboxPolicy,
      auditLog: h.auditLog,
      sinks: h.sinks,
      operatorLogger,
      basePromptPath: h.basePromptPath,
      validateModelsJsonOverride: noopValidate,
      loadSdkOverride: makeFakeSdkLoader(session),
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
    await waitFor(() => session.promptCalls.length > 0);
    const taskIdAtRun = (h.taskState.get() as { taskId: string }).taskId;

    session.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    });
    await waitFor(() => h.sinks.telegram.events.length > 0);

    // Find the mapper's framework_reply_emitted entry — must have task_id.
    const emitted = debugEntries.find((e) => e.event === "framework_reply_emitted");
    expect(emitted).toBeDefined();
    expect(emitted!.fields.task_id).toBe(taskIdAtRun);

    session.resolveCurrentPrompt!();
    await inflight;
    await mgr.dispose();
  });
});
