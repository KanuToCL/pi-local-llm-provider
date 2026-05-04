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
    // v0.2.2: watchdog now uses markTerminalAndIdle, which drains all the way
    // through to idle in a single atomic call.  Pre-v0.2.2 the test stopped at
    // `failed`; post-v0.2.2 the state should END at `idle`.  The audit row +
    // user-facing notice still fire on the way through (that's what we assert
    // below).  Wait for both state-drain AND the user-facing notice — the
    // notice fires AFTER markTerminalAndIdle's await flush() resolves, so it
    // can land a few microtasks after state-drain (avoid waitFor races).
    // Generous attempt cap because flush() awaits a real JsonStore write
    // through the workDir — under parallel test-suite load this can take many
    // setImmediate cycles.
    await waitFor(() => h.taskState.get().kind === "idle", 1000);
    await waitFor(
      () =>
        h.sinks.telegram.events.some(
          (e) =>
            e.type === "system_notice" && /watchdog|terminal event/i.test(e.text),
        ),
      1000,
    );

    expect(h.taskState.get().kind).toBe("idle");

    // System notice was emitted to the originating channel.
    const notice = h.sinks.telegram.events.find(
      (e) =>
        e.type === "system_notice" && /watchdog|terminal event/i.test(e.text),
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

    // v0.2.2: termination is now owned exclusively by handleInbound's
    // `await session.prompt()` resolution.  Resolve the prompt to drive a
    // normal completion (instead of emit({type: "agent_end"}) — that no longer
    // terminates).
    session.resolveCurrentPrompt!();
    await inflight;
    // After inflight resolves, markTaskCompletedAndIdle has run → state is idle.
    expect(h.taskState.get().kind).toBe("idle");

    // The watchdog timer ID should have been cleared (handleInbound's
    // try/finally clears the watchdog regardless of throw/no-throw).
    expect(clearedIds).toContain(watchdogTimer!.id);

    // Even if the watchdog handler somehow fired now, the task is in `idle`
    // state so it should be a no-op (fireWatchdog's CAS guard checks
    // running/backgrounded).
    watchdogTimer!.handler();
    await new Promise((r) => setImmediate(r));
    expect(h.taskState.get().kind).toBe("idle");

    // AUDIT-D NIT 9: defensive — ensure the watchdog did NOT emit a
    // user-facing notice when firing against an already-terminated task.
    expect(
      h.sinks.telegram.events.filter((e) => e.type === "system_notice"),
    ).toHaveLength(0);

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// v0.2.2 Test 1 (plan §A.6): multi-message_end load-bearing test.
//
// REPLACES the v0.2.1 "markTaskCompleted idempotence" test which guarded
// against double-firing of subscriber-driven termination side effects.  In
// v0.2.2 the subscriber NO LONGER terminates — termination is owned
// exclusively by handleInbound's `await session.prompt()` resolution.  The
// new contract is: intermediate message_end events MUST NOT trigger
// termination (the v0.2.1 IMPL-D-1 null-mapper-symmetry bug fired EVERY
// message_end as a terminator, producing the duration_ms=7 smoking gun
// per MIB-2026-05-03-2336).
// ---------------------------------------------------------------------------

describe("v0.2.2 termination contract (plan §A.6 Test 1)", () => {
  test("intermediate message_end events do NOT trigger termination — only prompt() resolution does", async () => {
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

    const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
    await waitFor(() => session.promptCalls.length > 0);
    expect(h.taskState.get().kind).toBe("running");

    // Fire 5 message_end events matching pi-mono's actual per-turn behavior:
    // user / assistant-with-tool-call / tool-result / empty-assistant /
    // final-assistant.  Pre-v0.2.2, EACH of these fired markTaskCompleted →
    // duration_ms=7 + state stuck in completed.
    session.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "x" }] },
    });
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "tool_call" }] },
    });
    session.emit({
      type: "message_end",
      message: { role: "tool", content: [{ type: "text", text: "ok" }] },
    });
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: [] },
    });
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final answer" }],
      },
    });

    // CRITICAL: state must STILL be running after 5 message_end events.  Pre-
    // v0.2.2 it would already be `completed` after the FIRST emit.  Yield a
    // few microtask turns so any (incorrect) state transition would land.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(h.taskState.get().kind).toBe("running");

    // No task_completed audit row should have been written yet.
    const linesPre = readAuditLines(join(workDir, "audit"));
    expect(linesPre.filter((e) => e.event === "task_completed")).toHaveLength(0);

    // NOW resolve the prompt — canonical terminal signal in v0.2.2.
    session.resolveCurrentPrompt!();
    await inflight;

    // Exactly ONE task_completed audit row + state is now idle (cyclicity).
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      return lines.filter((e) => e.event === "task_completed").length === 1;
    }, 1000);
    expect(h.taskState.get().kind).toBe("idle");

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// serial_queue_blocked user notice (plan v2 IMPL-D Step D.5).
// ---------------------------------------------------------------------------

describe("serial_queue_blocked user notice (plan v2 IMPL-D)", () => {
  test("second inbound while taskState busy emits system_notice to originating channel + audit entry", async () => {
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

    // v0.2.2: termination is now atomic (markTerminalAndIdle drains all the
    // way through to idle).  The pre-v0.2.2 hack of "force-background then
    // resolve prompt" no longer works — markTaskCompletedAndIdle drains state
    // to idle inside the queue lock, so a second handleInbound finds idle and
    // starts a new task instead of blocking.
    //
    // To exercise the busy-state path directly, we establish a `running`
    // state via tryTransition (bypassing handleInbound entirely so we don't
    // hold the queue lock), then call handleInbound which finds the busy
    // state and emits the serial_queue_blocked notice + audit row.
    h.taskState.tryTransition({
      kind: "running",
      taskId: "T-FAKE-LONG",
      startedAt: Date.now(),
      channel: "telegram",
      userMessage: "long task",
      abort: new AbortController(),
    });

    // Now state is `running`. The next inbound should be rejected with
    // a user-facing notice + audit entry.
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

    // Cleanup: drain state to idle so afterEach doesn't deadlock.
    const cur2 = h.taskState.get();
    if (cur2.kind === "running") {
      await h.taskState.markTerminalAndIdle({
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

    // v0.2.2: state stays `backgrounded` until handleInbound's
    // `await session.prompt()` resolves and markTaskCompletedAndIdle drains
    // it.  Pre-v0.2.2 the subscriber's mirror trigger would CAS to
    // `completed` here; in v0.2.2 the subscriber is fan-out only.
    expect(h.taskState.get().kind).toBe("backgrounded");

    // Now release the prompt — this drives the actual termination via the
    // canonical Choice D path (await session.prompt() → markTaskCompletedAndIdle).
    session.resolveCurrentPrompt!();
    await inflight;
    expect(h.taskState.get().kind).toBe("idle");
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

    // v0.2.2: same pattern as the test above — establish busy state via
    // tryTransition (bypassing handleInbound) so the busy-state branch can
    // be exercised without the markTerminalAndIdle drain re-clearing it.
    h.taskState.tryTransition({
      kind: "running",
      taskId: "T-FAKE-LONG",
      startedAt: nowMs.value,
      channel: "telegram",
      userMessage: "long",
      abort: new AbortController(),
    });

    h.sinks.telegram.events = [];

    // First dropped follow-up — emits notice + audit row.
    await mgr.handleInbound({ channel: "telegram", text: "drop 1" });
    const noticesAfterFirst = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" && /still working|previous request/i.test(e.text),
    );
    expect(noticesAfterFirst).toHaveLength(1);

    // Second dropped follow-up at +5s (within the 30s cooldown) — audit row
    // STILL fires, but NO new user-facing notice.
    nowMs.value += 5_000;
    await mgr.handleInbound({ channel: "telegram", text: "drop 2" });
    const noticesAfterSecond = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" && /still working|previous request/i.test(e.text),
    );
    expect(noticesAfterSecond).toHaveLength(1); // STILL 1 — suppressed.

    // Third dropped follow-up AFTER cooldown (advance past 30s from FIRST) —
    // notice fires again.
    nowMs.value += 30_000; // total +35s from first
    await mgr.handleInbound({ channel: "telegram", text: "drop 3" });
    const noticesAfterThird = h.sinks.telegram.events.filter(
      (e) =>
        e.type === "system_notice" && /still working|previous request/i.test(e.text),
    );
    expect(noticesAfterThird).toHaveLength(2);

    // Audit log: should have THREE serial_queue_blocked rows (one per drop).
    let blockedCount = 0;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      blockedCount = lines
        .filter((e) => e.event === "serial_queue_blocked")
        .length;
      return blockedCount >= 3;
    }, 1000);
    expect(blockedCount).toBe(3);

    // Cleanup.
    const cur2 = h.taskState.get();
    if (cur2.kind === "running") {
      await h.taskState.markTerminalAndIdle({
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

// ===========================================================================
// v0.2.2 plan §A.6 — Tests 2-9.  Test 1 lives at line ~1192.
// ===========================================================================

// ---------------------------------------------------------------------------
// Test 2 — duration_ms realism (Testing B2 + Obs S2).
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 2: duration_ms realism", () => {
  test("task_completed duration_ms reflects actual prompt() wall-clock, not subscriber-event arrival time", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
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
      now: () => nowMs,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
    await waitFor(() => session.promptCalls.length > 0);

    // Intermediate events at +7ms (the v0.2.1 smoking gun was duration_ms=7
    // because EVERY message_end fired markTaskCompleted).  In v0.2.2 these
    // are pure no-ops vs termination.
    nowMs += 7;
    session.emit({
      type: "message_end",
      message: { role: "assistant", content: [] },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Real inference takes 2 seconds.
    nowMs += 2000;
    session.resolveCurrentPrompt!();
    await inflight;

    // Find the task_completed audit row.
    let completed: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      completed = lines.find((e) => e.event === "task_completed");
      return completed !== undefined;
    }, 1000);
    expect(completed).toBeDefined();
    expect(completed!.duration_ms).toBeGreaterThanOrEqual(2000);
    expect(completed!.duration_ms).not.toBe(7);

    // Defense-in-depth: no `task_completed_suspiciously_fast` alarm
    // (duration_ms ≥ 100).
    const lines = readAuditLines(join(workDir, "audit"));
    expect(
      lines.filter((e) => e.event === "task_completed_suspiciously_fast"),
    ).toHaveLength(0);

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — task_completed_suspiciously_fast fires when duration_ms < 100ms.
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 3: suspiciously-fast alarm (Obs W1)", () => {
  test("task_completed_suspiciously_fast audit fires when duration_ms < 100ms — catches v0.2.1 bug regression", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
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
      now: () => nowMs,
    });
    await mgr.init();

    const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
    await waitFor(() => session.promptCalls.length > 0);

    // Resolve the prompt at +50ms (well below 100ms threshold).
    nowMs += 50;
    session.resolveCurrentPrompt!();
    await inflight;

    let fast: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      fast = lines.find(
        (e) => e.event === "task_completed_suspiciously_fast",
      );
      return fast !== undefined;
    }, 1000);
    expect(fast).toBeDefined();
    expect(fast!.duration_ms).toBe(50);

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — N=10 sequential inbounds all complete; cyclicity survives.
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 4: N=10 cyclicity (Testing B3)", () => {
  test("N=10 sequential inbounds all complete: state cyclicity survives across many turns", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
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
      now: () => nowMs,
    });
    await mgr.init();

    for (let i = 0; i < 10; i++) {
      const inflight = mgr.handleInbound({
        channel: "telegram",
        text: `msg ${i}`,
      });
      await waitFor(() => session.promptCalls.length === i + 1);
      expect(h.taskState.get().kind).toBe("running");
      nowMs += 200;
      session.resolveCurrentPrompt!();
      await inflight;
      // Cyclicity: state MUST drain back to idle for each round so the next
      // CAS to running can succeed.
      expect(h.taskState.get().kind).toBe("idle");
    }

    // Audit-log shape: 10 task_started + 10 task_completed + 0 cas_failed.
    let startedCount = 0;
    let completedCount = 0;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      startedCount = lines.filter((e) => e.event === "task_started").length;
      completedCount = lines.filter((e) => e.event === "task_completed").length;
      return startedCount === 10 && completedCount === 10;
    }, 2000);
    expect(startedCount).toBe(10);
    expect(completedCount).toBe(10);

    const lines = readAuditLines(join(workDir, "audit"));
    expect(
      lines.filter((e) => e.event === "task_state_cas_failed"),
    ).toHaveLength(0);

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Mixed N=10 (throws + successes) cyclicity.
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 5: mixed N=10 cyclicity", () => {
  test("mixed N=10 (throws + successes) all reach a terminal state, NO silent drops", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
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
      now: () => nowMs,
    });
    await mgr.init();

    // Replace fake session.prompt() to throw on odd iterations.  The
    // override owns the prompt-call bookkeeping (do NOT delegate to the
    // original, otherwise promptCalls double-counts).
    let iteration = 0;
    session.prompt = async function (text: string): Promise<void> {
      this.promptCalls.push({ text });
      const myIter = iteration++;
      if (myIter % 2 === 1) {
        throw new Error(`iteration ${myIter} failed`);
      }
      // Even iterations: block until resolveCurrentPrompt fires.
      await new Promise<void>((resolve) => {
        this.resolveCurrentPrompt = resolve;
      });
    };

    for (let i = 0; i < 10; i++) {
      const inflight = mgr.handleInbound({
        channel: "telegram",
        text: `msg ${i}`,
      });
      // For successes, wait for prompt then resolve.  For throws, the
      // prompt-call is recorded synchronously then throws, so we just await.
      if (i % 2 === 0) {
        await waitFor(() => session.promptCalls.length === i + 1);
        nowMs += 200;
        session.resolveCurrentPrompt!();
      }
      await inflight;
      expect(h.taskState.get().kind).toBe("idle");
    }

    let startedCount = 0;
    let completedCount = 0;
    let failedCount = 0;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      startedCount = lines.filter((e) => e.event === "task_started").length;
      completedCount = lines.filter((e) => e.event === "task_completed").length;
      failedCount = lines.filter((e) => e.event === "task_failed").length;
      return startedCount === 10 && completedCount + failedCount === 10;
    }, 2000);
    expect(startedCount).toBe(10);
    expect(completedCount).toBe(5);
    expect(failedCount).toBe(5);

    const lines = readAuditLines(join(workDir, "audit"));
    expect(
      lines.filter((e) => e.event === "task_state_cas_failed"),
    ).toHaveLength(0);

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Production-replay regression trap (MIB-2026-05-03-2336).
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 6: MIB-2026-05-03-2336 regression trap", () => {
  test("3 sequential inbounds (the production transcript) all produce replies + realistic duration_ms", async () => {
    const h = makeHarness();
    const session = makeFakeSession();
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
      now: () => nowMs,
    });
    await mgr.init();

    const inputs = [
      "say only: i am terminator",
      "say now: im snow white",
      "again?",
    ];

    for (let i = 0; i < inputs.length; i++) {
      const inflight = mgr.handleInbound({
        channel: "telegram",
        text: inputs[i]!,
      });
      await waitFor(() => session.promptCalls.length === i + 1);

      // Simulate pi-mono streaming: emit a couple of intermediate
      // message_end events (user/tool/empty) — pre-v0.2.2 each of these
      // would have terminated the task with duration_ms=7.
      session.emit({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: inputs[i]! }] },
      });
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `reply to msg ${i}` }],
        },
      });

      // Realistic inference time.
      nowMs += 500;
      session.resolveCurrentPrompt!();
      await inflight;

      // After each: state idle (cyclicity preserved — pre-v0.2.2 messages
      // 2 + 3 silently dropped because state stuck in `completed`).
      expect(h.taskState.get().kind).toBe("idle");
    }

    // ALL 3 task_completed audit rows must have realistic duration_ms ≥ 100ms.
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      return (
        lines.filter((e) => e.event === "task_completed").length === 3
      );
    }, 2000);
    const lines = readAuditLines(join(workDir, "audit"));
    const completedRows = lines.filter((e) => e.event === "task_completed");
    expect(completedRows).toHaveLength(3);
    for (const row of completedRows) {
      expect(row.duration_ms as number).toBeGreaterThanOrEqual(500);
      expect(row.duration_ms as number).not.toBe(7);
    }
    // No suspiciously-fast alarms.
    expect(
      lines.filter((e) => e.event === "task_completed_suspiciously_fast"),
    ).toHaveLength(0);
    // All 3 reply ChannelEvents made it to the telegram sink.
    expect(
      h.sinks.telegram.events.filter((e) => e.type === "reply"),
    ).toHaveLength(3);

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 7 — task_state_cas_failed audit zod-safety (Adversarial B1).
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 7: task_state_cas_failed audit zod-safety", () => {
  test("task_state_cas_failed audit row passes zod schema validation (no undefined fields)", async () => {
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

    // Trigger a TRUE-bug CAS failure (NOT a terminal-state race): patch
    // tryTransition to refuse the CAS-to-running.  emitCasFailure routes
    // {from: idle, to: running} as a true bug because `to` is non-terminal
    // (TERMINAL_RACE_KINDS only includes idle + completed/failed/cancelled).
    const origTryTransition = h.taskState.tryTransition.bind(h.taskState);
    h.taskState.tryTransition = function (next): { ok: boolean; reason?: string } {
      if (next.kind === "running") {
        return { ok: false, reason: "synthetic test failure" };
      }
      return origTryTransition(next);
    };

    await mgr.handleInbound({ channel: "telegram", text: "follow-up" });

    // Restore.
    h.taskState.tryTransition = origTryTransition;

    // Audit row must be present + schema-valid (no missing extra.reason etc).
    let row: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      row = lines.find((e) => e.event === "task_state_cas_failed");
      return row !== undefined;
    }, 1000);
    expect(row).toBeDefined();
    expect(row!.channel).toBe("system");
    const extra = row!.extra as Record<string, unknown>;
    expect(extra).toBeDefined();
    expect(typeof extra.from).toBe("string");
    expect(typeof extra.to).toBe("string");
    expect(typeof extra.reason).toBe("string");
    expect(typeof extra.context).toBe("string");
    // Reason must be the synthetic one (no `?? "unknown"` fallback firing).
    expect(extra.reason).toBe("synthetic test failure");
    expect(extra.from).toBe("idle");
    expect(extra.to).toBe("running");

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — restoreFromDisk emits task_state_recovered_on_restart audit.
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 8: terminal-state recovery audit", () => {
  test("init() with completed state on disk emits task_state_recovered_on_restart audit", async () => {
    const h = makeHarness();
    const persistencePath = join(workDir, "task-state.json");
    // Pre-populate disk with a completed state (simulates crash between
    // markTerminalAndIdle's terminal CAS and idle flush).
    writeFileSync(
      persistencePath,
      JSON.stringify({
        kind: "completed",
        taskId: "T-RECOVERED",
        startedAt: 1_000,
        finishedAt: 2_500,
      }),
      "utf8",
    );

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

    // State drained to idle.
    expect(taskState.get().kind).toBe("idle");

    // Audit row emitted with prior_kind + task_id.
    let row: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      row = lines.find(
        (e) => e.event === "task_state_recovered_on_restart",
      );
      return row !== undefined;
    }, 1000);
    expect(row).toBeDefined();
    expect(row!.task_id).toBe("T-RECOVERED");
    expect(row!.channel).toBe("system");
    const extra = row!.extra as Record<string, unknown>;
    expect(extra.prior_kind).toBe("completed");

    await mgr.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 9 — handleInbound terminal-state cyclicity-normalize (the MIB §3
// silent-drop regression).
// ---------------------------------------------------------------------------
describe("v0.2.2 §A.6 Test 9: cyclicity-normalize on stuck-completed state", () => {
  test("inbound after stuck-in-completed: cyclicity guard recovers + new task_started fires", async () => {
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

    // Force state to `completed` (bypassing markTerminalAndIdle to simulate
    // the v0.2.1 silent-drop regression: the subscriber's mirror would set
    // state to completed and nothing would call the completed→idle edge).
    h.taskState.tryTransition({
      kind: "running",
      taskId: "T-STUCK",
      startedAt: 1_000,
      channel: "telegram",
      userMessage: "x",
      abort: new AbortController(),
    });
    h.taskState.tryTransition({
      kind: "completed",
      taskId: "T-STUCK",
      startedAt: 1_000,
      finishedAt: 2_000,
    });
    expect(h.taskState.get().kind).toBe("completed");

    // Pre-v0.2.2 this inbound would silently drop (CAS to running fails
    // because state is in `completed`, not `idle`).  Post-v0.2.2 the
    // cyclicity-normalize guard inside handleInbound recovers via the
    // completed→idle edge, then CAS to running succeeds.
    const inflight = mgr.handleInbound({
      channel: "telegram",
      text: "follow-up after stuck",
    });
    await waitFor(() => session.promptCalls.length > 0);

    // task_started audit row fires for the new task.
    let started: Record<string, unknown> | undefined;
    await waitFor(() => {
      const lines = readAuditLines(join(workDir, "audit"));
      started = lines.find((e) => e.event === "task_started");
      return started !== undefined;
    }, 1000);
    expect(started).toBeDefined();

    // State is now running for the NEW task (not the stuck T-STUCK).
    const cur = h.taskState.get();
    expect(cur.kind).toBe("running");
    if (cur.kind === "running") {
      expect(cur.taskId).not.toBe("T-STUCK");
    }

    // Emit a message_end so the subscriber fans out a reply ChannelEvent
    // (terminating side-effects are owned by markTaskCompletedAndIdle in
    // v0.2.2; the subscriber is fan-out only).
    session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I recovered from the stuck state" }],
      },
    });
    session.resolveCurrentPrompt!();
    await inflight;
    // Reply landed (no silent drop) AND state drained back to idle.
    expect(h.sinks.telegram.events.length).toBeGreaterThan(0);
    const reply = h.sinks.telegram.events.find((e) => e.type === "reply");
    expect(reply).toBeDefined();
    expect(h.taskState.get().kind).toBe("idle");

    await mgr.dispose();
  });
});
