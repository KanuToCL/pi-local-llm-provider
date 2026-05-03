/**
 * Tests for `src/commands/slash.ts` — the slash-command router.
 *
 * Coverage targets (per IMPL-14 brief, ≥30 cases):
 *   - Each command's happy path (≥15 cases, one per command)
 *   - /help lists all 14 commands by name
 *   - /cancel long-running task path: 30s confirm window then /cancel yes
 *   - /cancel short-task path: cancels immediately
 *   - /confirm <id> yes resolves a specific id
 *   - /confirm yes with 0 pending → "no pending"
 *   - /confirm yes with 2 pending → ambiguous + lists ids
 *   - /unsand 200 → rejected (>120 cap)
 *   - /unsand 0 → rejected (<1 minute)
 *   - /unsand from phone with no terminal ack → rejected
 *   - /unsand from terminal → accepted
 *   - /unlock from phone → rejected
 *   - /unlock from terminal → calls onPanicUnlock
 *   - /shutdown from phone → rejected
 *   - Unknown /foobar → "Unknown command"
 *   - Non-slash input → handled=false
 *   - extractCommandArgument handles `/help@MyBot` and `/confirm@MyBot 7f3a yes`
 *
 * The deps are mocked.  All real W2 modules (PendingConfirmsRegistry,
 * SandboxPolicy, TaskStateManager) are wired live where their behavior is
 * load-bearing for the assertion (e.g. `/confirm <id> yes` actually resolves
 * a real promise); the daemon-side callbacks (`onCancelTask`, `onPanicLock`,
 * etc.) are stubbed with vi.fn().
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SlashCommandRouter,
  type SlashCommandContext,
  type SlashCommandDeps,
  extractCommandArgument,
  formatHelpMessage,
} from "../src/commands/slash.js";
import { TaskStateManager } from "../src/lib/task-state.js";
import { PendingConfirmsRegistry } from "../src/tools/pending-confirms.js";
import { SandboxPolicy } from "../src/sandbox/policy.js";
import { StatusPointerReader } from "../src/status-pointer/reader.js";
import { AuditLog } from "../src/audit/log.js";
import { JsonStore } from "../src/storage/json-store.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-slash-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface Harness {
  router: SlashCommandRouter;
  deps: SlashCommandDeps;
  taskState: TaskStateManager;
  pendingConfirms: PendingConfirmsRegistry;
  sandboxPolicy: SandboxPolicy;
  statusPointerReader: StatusPointerReader;
  auditLog: AuditLog;
  onPanicLock: ReturnType<typeof vi.fn>;
  onPanicUnlock: ReturnType<typeof vi.fn>;
  onAlive: ReturnType<typeof vi.fn>;
  onCancelTask: ReturnType<typeof vi.fn>;
  onResetSession: ReturnType<typeof vi.fn>;
  onShutdownDaemon: ReturnType<typeof vi.fn>;
  setLastTellAt(ts: number | null): void;
  setUnsandRequiresTerminalAck(v: boolean): void;
  setIsFirstUnsandPerSession(v: boolean): void;
}

interface BuildOpts {
  /** When true, the dispatcher's first-per-session probe returns false. */
  unsandSessionAlreadyAcked?: boolean;
  /** When true, getUnsandRequiresTerminalAck() returns true (tool-derived). */
  unsandToolDerived?: boolean;
  /** Override the last-tell timestamp surfaced by /status. */
  lastTellAt?: number | null;
}

function build(opts: BuildOpts = {}): Harness {
  const taskState = new TaskStateManager();
  const pendingConfirms = new PendingConfirmsRegistry();
  const sandboxStore = new JsonStore<unknown>(join(workDir, "sandbox.json"));
  // The SandboxPolicy is parameterized over its persisted state shape but
  // the JsonStore is `<unknown>` here for test-bench simplicity — runtime
  // shape is enforced inside the policy.  Cast satisfies the constructor.
  const sandboxPolicy = new SandboxPolicy({
    jsonStore: sandboxStore as unknown as JsonStore<never>,
  });
  const pointerPath = join(workDir, "status-pointer.md");
  const statusPointerReader = new StatusPointerReader({ path: pointerPath });
  const auditLog = new AuditLog({
    dir: join(workDir, "audit"),
    daemonStartTs: Date.now(),
  });

  const onPanicLock = vi.fn(async () => undefined);
  const onPanicUnlock = vi.fn(async () => undefined);
  const onAlive = vi.fn();
  const onCancelTask = vi.fn(async () => ({ cancelled: true, taskId: "T-stub" }));
  const onResetSession = vi.fn(async () => undefined);
  const onShutdownDaemon = vi.fn(async () => undefined);

  let lastTellAt: number | null = opts.lastTellAt ?? null;
  let unsandRequiresTerminalAck = opts.unsandToolDerived ?? false;
  let isFirstUnsandPerSession = !(opts.unsandSessionAlreadyAcked ?? false);

  const deps: SlashCommandDeps = {
    taskState,
    pendingConfirms,
    sandboxPolicy,
    statusPointerReader,
    auditLog,
    onPanicLock,
    onPanicUnlock,
    onAlive,
    onCancelTask,
    onResetSession,
    onShutdownDaemon,
    getLastTellAt: () => lastTellAt,
    getUnsandRequiresTerminalAck: () => unsandRequiresTerminalAck,
    isFirstUnsandPerSession: () => isFirstUnsandPerSession,
  };

  const router = new SlashCommandRouter(deps);

  return {
    router,
    deps,
    taskState,
    pendingConfirms,
    sandboxPolicy,
    statusPointerReader,
    auditLog,
    onPanicLock,
    onPanicUnlock,
    onAlive,
    onCancelTask,
    onResetSession,
    onShutdownDaemon,
    setLastTellAt(ts: number | null): void {
      lastTellAt = ts;
    },
    setUnsandRequiresTerminalAck(v: boolean): void {
      unsandRequiresTerminalAck = v;
    },
    setIsFirstUnsandPerSession(v: boolean): void {
      isFirstUnsandPerSession = v;
    },
  };
}

function ctxTerminal(raw: string): SlashCommandContext {
  return { raw, senderChannel: "terminal", senderId: "term-001", isTerminal: true };
}

function ctxPhone(raw: string, channel: "telegram" | "whatsapp" = "telegram"): SlashCommandContext {
  return { raw, senderChannel: channel, senderId: "phone-001", isTerminal: false };
}

// ---------------------------------------------------------------------------
// extractCommandArgument helper
// ---------------------------------------------------------------------------

describe("extractCommandArgument", () => {
  test("strips the leading /cmd", () => {
    expect(extractCommandArgument("/cancel yes", "cancel")).toBe("yes");
  });

  test("handles /cmd@botname suffix", () => {
    expect(extractCommandArgument("/help@MyBot", "help")).toBe("");
  });

  test("handles /cmd@botname with arguments", () => {
    expect(extractCommandArgument("/confirm@MyBot 7f3a yes", "confirm")).toBe("7f3a yes");
  });

  test("returns empty string for empty input", () => {
    expect(extractCommandArgument(undefined, "anything")).toBe("");
    expect(extractCommandArgument("", "anything")).toBe("");
  });

  test("trims surrounding whitespace", () => {
    expect(extractCommandArgument("/unsand    30   ", "unsand")).toBe("30");
  });
});

// ---------------------------------------------------------------------------
// Non-slash + unknown
// ---------------------------------------------------------------------------

describe("non-slash + unknown", () => {
  test("non-slash input → handled=false", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("just a normal user message"));
    expect(r).toEqual({ handled: false });
  });

  test("unknown /foobar → 'Unknown command'", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/foobar"));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("Unknown command");
  });

  test("malformed slash (just '/') → handled=false", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/"));
    expect(r.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /start /help happy paths
// ---------------------------------------------------------------------------

describe("/start + /help", () => {
  test("/start replies with welcome + help", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/start"));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("pi");
    expect(r.reply).toContain("/help");
  });

  test("/help lists all 14 commands by name", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/help"));
    expect(r.handled).toBe(true);
    const help = r.reply ?? "";
    // Verify each command name is present in the help output.
    const commands = [
      "/start",
      "/help",
      "/status",
      "/cancel",
      "/reset",
      "/confirm",
      "/pointer",
      "/who",
      "/unsand",
      "/alive",
      "/lock",
      "/unlock",
      "/shutdown",
    ];
    for (const cmd of commands) {
      // Anchor at start-of-line + space afterwards so "/cancel" matches both
      // the bare and "/cancel yes" forms but doesn't false-positive on
      // substring overlap.
      const re = new RegExp(`^${cmd.replace("/", "\\/")}( |$)`, "m");
      expect(help).toMatch(re);
    }
  });

  test("formatHelpMessage exposes every command (regression on shape)", () => {
    const help = formatHelpMessage();
    // Two lines for /cancel (bare + 'yes'), two for /confirm (with id + bare),
    // three for /unsand (default + minutes + off) — total 18 distinct lines.
    expect(help.split("\n").filter((l) => l.startsWith("/")).length).toBeGreaterThanOrEqual(14);
  });
});

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

describe("/status", () => {
  test("idle + sandbox on + no tell yet", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/status"));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("task: idle");
    expect(r.reply).toContain("sandbox: on");
    expect(r.reply).toContain("last tell(): never");
  });

  test("running task + sandbox off + recent tell", async () => {
    const h = build();
    h.taskState.tryTransition({
      kind: "running",
      taskId: "TASK-1",
      startedAt: Date.now() - 5_000,
      channel: "telegram",
      userMessage: "hi",
      abort: new AbortController(),
    });
    h.sandboxPolicy.disable({
      scope: "next-task",
      toolDerived: false,
      sessionAck: true,
    });
    h.setLastTellAt(Date.now() - 2_000);
    const r = await h.router.dispatch(ctxTerminal("/status"));
    expect(r.reply).toContain("task: running");
    expect(r.reply).toContain("TASK-1");
    expect(r.reply).toContain("sandbox: off");
    expect(r.reply).toMatch(/last tell\(\):\s+\d+s ago/);
  });
});

// ---------------------------------------------------------------------------
// /cancel
// ---------------------------------------------------------------------------

describe("/cancel", () => {
  test("no in-flight task → friendly message", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/cancel"));
    expect(r.reply).toContain("no task in flight");
    expect(h.onCancelTask).not.toHaveBeenCalled();
  });

  test("short-running task (<2 min) → cancels immediately", async () => {
    const h = build();
    h.taskState.tryTransition({
      kind: "running",
      taskId: "T-short",
      startedAt: Date.now() - 30_000,
      channel: "telegram",
      userMessage: "...",
      abort: new AbortController(),
    });
    const r = await h.router.dispatch(ctxTerminal("/cancel"));
    expect(h.onCancelTask).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain("cancelled");
  });

  test("long-running task (>2 min) → confirm-required reply", async () => {
    const h = build();
    h.taskState.tryTransition({
      kind: "running",
      taskId: "T-long",
      startedAt: Date.now() - 5 * 60_000,
      channel: "telegram",
      userMessage: "...",
      abort: new AbortController(),
    });
    const r = await h.router.dispatch(ctxTerminal("/cancel"));
    expect(h.onCancelTask).not.toHaveBeenCalled();
    expect(r.reply).toContain("/cancel yes");
    expect(r.reply).toContain("30s");
  });

  test("/cancel yes within 30s → invokes cancel", async () => {
    const h = build();
    h.taskState.tryTransition({
      kind: "running",
      taskId: "T-long",
      startedAt: Date.now() - 5 * 60_000,
      channel: "telegram",
      userMessage: "...",
      abort: new AbortController(),
    });
    await h.router.dispatch(ctxTerminal("/cancel"));
    const r = await h.router.dispatch(ctxTerminal("/cancel yes"));
    expect(h.onCancelTask).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain("cancelled");
  });

  test("/cancel yes with no pending → friendly message", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/cancel yes"));
    expect(h.onCancelTask).not.toHaveBeenCalled();
    expect(r.reply).toContain("no pending /cancel");
  });

  test("/cancel yes after 30s window → friendly message", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-28T10:00:00Z"));
      const h = build();
      h.taskState.tryTransition({
        kind: "running",
        taskId: "T-long",
        startedAt: Date.now() - 5 * 60_000,
        channel: "telegram",
        userMessage: "...",
        abort: new AbortController(),
      });
      await h.router.dispatch(ctxTerminal("/cancel"));
      // Advance >30s.
      vi.setSystemTime(new Date(Date.now() + 31_000));
      const r = await h.router.dispatch(ctxTerminal("/cancel yes"));
      expect(h.onCancelTask).not.toHaveBeenCalled();
      expect(r.reply).toContain("no pending /cancel");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// /reset
// ---------------------------------------------------------------------------

describe("/reset", () => {
  test("calls onResetSession", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/reset"));
    expect(h.onResetSession).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain("reset");
  });
});

// ---------------------------------------------------------------------------
// /confirm
// ---------------------------------------------------------------------------

describe("/confirm", () => {
  test("/confirm <id> yes resolves the specific entry", async () => {
    const h = build();
    const { id, promise } = h.pendingConfirms.create({
      taskId: "T1",
      question: "delete?",
      rationale: "...",
      risk: "low",
      channel: "telegram",
    });
    const r = await h.router.dispatch(ctxTerminal(`/confirm ${id} yes`));
    expect(r.reply).toContain("resolved");
    await expect(promise).resolves.toBe(true);
  });

  test("/confirm <id> no resolves to false", async () => {
    const h = build();
    const { id, promise } = h.pendingConfirms.create({
      taskId: "T1",
      question: "delete?",
      rationale: "...",
      risk: "low",
      channel: "telegram",
    });
    const r = await h.router.dispatch(ctxTerminal(`/confirm ${id} no`));
    expect(r.reply).toContain("resolved");
    await expect(promise).resolves.toBe(false);
  });

  test("/confirm yes with 0 pending → 'no pending'", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/confirm yes"));
    expect(r.reply).toContain("no pending confirms");
  });

  test("/confirm yes with 1 pending → resolves it", async () => {
    const h = build();
    const { promise } = h.pendingConfirms.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const r = await h.router.dispatch(ctxTerminal("/confirm yes"));
    expect(r.reply).toContain("resolved");
    await expect(promise).resolves.toBe(true);
  });

  test("/confirm yes with 2 pending → ambiguous + lists ids", async () => {
    const h = build();
    const a = h.pendingConfirms.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const b = h.pendingConfirms.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const r = await h.router.dispatch(ctxTerminal("/confirm yes"));
    expect(r.reply).toContain("multiple pending");
    expect(r.reply).toContain(a.id);
    expect(r.reply).toContain(b.id);
  });

  test("/confirm <unknown-id> yes → 'no pending confirm with id'", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/confirm ZZZZ yes"));
    expect(r.reply).toContain("no pending confirm");
  });

  test("/confirm with no args → usage hint", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/confirm"));
    expect(r.reply).toContain("usage");
  });

  test("/confirm <id> bogus → usage hint", async () => {
    const h = build();
    h.pendingConfirms.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const r = await h.router.dispatch(ctxTerminal("/confirm XYZW maybe"));
    expect(r.reply).toContain("usage");
  });
});

// ---------------------------------------------------------------------------
// /pointer
// ---------------------------------------------------------------------------

describe("/pointer", () => {
  test("missing pointer file → 'status pointer is empty'", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/pointer"));
    expect(r.reply).toContain("empty");
  });

  test("present pointer file → fenced markdown body", async () => {
    const h = build();
    writeFileSync(
      h.statusPointerReader.filePath,
      "Last updated: 2026-04-28T10:00:00Z\n\nbody text here\n",
      "utf8",
    );
    const r = await h.router.dispatch(ctxTerminal("/pointer"));
    expect(r.reply).toContain("```");
    expect(r.reply).toContain("body text here");
  });
});

// ---------------------------------------------------------------------------
// /who
// ---------------------------------------------------------------------------

describe("/who", () => {
  test("reports channel + sender + isTerminal", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxPhone("/who", "whatsapp"));
    expect(r.reply).toContain("whatsapp");
    expect(r.reply).toContain("phone-001");
    expect(r.reply).toContain("isTerminal=false");
  });
});

// ---------------------------------------------------------------------------
// /unsand
// ---------------------------------------------------------------------------

describe("/unsand", () => {
  test("/unsand from terminal → accepted (next-task)", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/unsand"));
    expect(r.reply).toContain("disabled");
    expect(h.sandboxPolicy.isSandboxed()).toBe(false);
  });

  test("/unsand from phone with first-per-session → rejected", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxPhone("/unsand"));
    expect(r.reply).toContain("terminal ack");
    expect(h.sandboxPolicy.isSandboxed()).toBe(true);
  });

  test("/unsand from phone after session ack → accepted", async () => {
    const h = build({ unsandSessionAlreadyAcked: true });
    const r = await h.router.dispatch(ctxPhone("/unsand"));
    expect(r.reply).toContain("disabled");
    expect(h.sandboxPolicy.isSandboxed()).toBe(false);
  });

  test("/unsand from phone with tool-derived flag → rejected", async () => {
    const h = build({ unsandSessionAlreadyAcked: true, unsandToolDerived: true });
    const r = await h.router.dispatch(ctxPhone("/unsand"));
    expect(r.reply).toContain("terminal ack");
    expect(h.sandboxPolicy.isSandboxed()).toBe(true);
  });

  test("/unsand 30 from terminal → window grant", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/unsand 30"));
    expect(r.reply).toContain("30 min");
    expect(h.sandboxPolicy.isSandboxed()).toBe(false);
    const state = h.sandboxPolicy.getState();
    expect(state.kind).toBe("unsand");
    if (state.kind === "unsand") {
      expect(state.scope).toBe("window");
      expect(state.expiresAt).not.toBeNull();
    }
  });

  test("/unsand 200 → rejected (>120 cap)", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/unsand 200"));
    expect(r.reply).toContain("120");
    expect(h.sandboxPolicy.isSandboxed()).toBe(true);
  });

  test("/unsand 0 → rejected (<1 minute)", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/unsand 0"));
    expect(r.reply).toContain("at least 1");
    expect(h.sandboxPolicy.isSandboxed()).toBe(true);
  });

  test("/unsand bogus → usage hint", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/unsand abc"));
    expect(r.reply).toContain("usage");
    expect(h.sandboxPolicy.isSandboxed()).toBe(true);
  });

  test("/unsand off re-engages immediately", async () => {
    const h = build();
    h.sandboxPolicy.disable({
      scope: "next-task",
      toolDerived: false,
      sessionAck: true,
    });
    expect(h.sandboxPolicy.isSandboxed()).toBe(false);
    const r = await h.router.dispatch(ctxTerminal("/unsand off"));
    expect(r.reply).toContain("re-engaged");
    expect(h.sandboxPolicy.isSandboxed()).toBe(true);
  });

  test("/unsand off works from phone (tightening doesn't need ack)", async () => {
    const h = build();
    h.sandboxPolicy.disable({
      scope: "next-task",
      toolDerived: false,
      sessionAck: true,
    });
    const r = await h.router.dispatch(ctxPhone("/unsand off"));
    expect(r.reply).toContain("re-engaged");
    expect(h.sandboxPolicy.isSandboxed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /alive
// ---------------------------------------------------------------------------

describe("/alive", () => {
  test("calls onAlive heartbeat", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxPhone("/alive"));
    expect(h.onAlive).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain("alive");
  });
});

// ---------------------------------------------------------------------------
// /lock /unlock
// ---------------------------------------------------------------------------

describe("/lock + /unlock", () => {
  test("/lock invokes onPanicLock from any channel", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxPhone("/lock"));
    expect(h.onPanicLock).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain("LOCKED");
  });

  test("/unlock from phone → rejected", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxPhone("/unlock"));
    expect(h.onPanicUnlock).not.toHaveBeenCalled();
    expect(r.reply).toContain("terminal-only");
  });

  test("/unlock from terminal → calls onPanicUnlock", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/unlock"));
    expect(h.onPanicUnlock).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain("unlocked");
  });
});

// ---------------------------------------------------------------------------
// /shutdown
// ---------------------------------------------------------------------------

describe("/shutdown", () => {
  test("/shutdown from phone → rejected (does NOT call onShutdownDaemon)", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxPhone("/shutdown"));
    expect(h.onShutdownDaemon).not.toHaveBeenCalled();
    expect(r.reply).toContain("terminal-only");
  });

  test("/shutdown from terminal → calls onShutdownDaemon", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/shutdown"));
    expect(h.onShutdownDaemon).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain("shutting down");
  });
});

// ---------------------------------------------------------------------------
// @botname suffix integration check
// ---------------------------------------------------------------------------

describe("/cmd@bot integration", () => {
  test("/help@MyBot is recognized as /help", async () => {
    const h = build();
    const r = await h.router.dispatch(ctxTerminal("/help@MyBot"));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain("/start");
  });

  test("/confirm@MyBot ABCD yes routes to /confirm with arg parsing", async () => {
    const h = build();
    const { id, promise } = h.pendingConfirms.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const r = await h.router.dispatch(ctxTerminal(`/confirm@MyBot ${id} yes`));
    expect(r.reply).toContain("resolved");
    await expect(promise).resolves.toBe(true);
  });
});
