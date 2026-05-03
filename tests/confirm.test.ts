import { describe, expect, test } from "vitest";
import {
  defineConfirmTool,
  type ConfirmResult,
  type PendingConfirmCreateOptions,
  type PendingConfirmHandle,
  type PendingConfirmsRegistry,
} from "../src/tools/confirm.js";
import type { ChannelEvent, Sink } from "../src/tools/types.js";

// ---------------------------------------------------------------------------
// Test helpers — minimal in-memory PendingConfirmsRegistry stub.
//
// Mirrors the contract IMPL-7 will satisfy at src/tools/pending-confirms.ts.
// We track per-task pending count and let the test drive resolution.
// ---------------------------------------------------------------------------

interface PendingHandle extends PendingConfirmHandle {
  resolve: (decision: "yes" | "no" | "timeout") => void;
}

class FakePendingConfirms implements PendingConfirmsRegistry {
  readonly maxPerTask: number;
  private byTask = new Map<string, Set<string>>();
  private byShortId = new Map<string, PendingHandle>();
  private nextId = 0;
  private nowFn: () => number;

  constructor(maxPerTask = 3, nowFn: () => number = Date.now) {
    this.maxPerTask = maxPerTask;
    this.nowFn = nowFn;
  }

  countForTask(taskId: string): number {
    return this.byTask.get(taskId)?.size ?? 0;
  }

  create(opts: PendingConfirmCreateOptions): PendingConfirmHandle {
    if (this.countForTask(opts.taskId) >= this.maxPerTask) {
      throw new Error("confirm cap exceeded for task " + opts.taskId);
    }
    const shortId = `T${(this.nextId++).toString(36).toUpperCase().padStart(3, "0")}`;
    const ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    const expiresAt = this.nowFn() + ttlMs;

    let resolveFn!: (decision: "yes" | "no" | "timeout") => void;
    const promise = new Promise<{ decision: "yes" | "no" | "timeout" }>((resolve) => {
      resolveFn = (decision) => resolve({ decision });
    });

    const handle: PendingHandle = {
      shortId,
      expiresAt,
      promise,
      resolve: (decision) => {
        // remove from registry on resolution
        this.byTask.get(opts.taskId)?.delete(shortId);
        this.byShortId.delete(shortId);
        resolveFn(decision);
      },
    };

    let set = this.byTask.get(opts.taskId);
    if (!set) {
      set = new Set();
      this.byTask.set(opts.taskId, set);
    }
    set.add(shortId);
    this.byShortId.set(shortId, handle);

    return handle;
  }

  /** Test-only: resolve a pending confirm by shortId. */
  drive(shortId: string, decision: "yes" | "no" | "timeout"): void {
    const h = this.byShortId.get(shortId);
    if (!h) throw new Error("no such pending confirm: " + shortId);
    h.resolve(decision);
  }

  /** Test-only: resolve the most-recently-created pending confirm. */
  driveLatest(decision: "yes" | "no" | "timeout"): void {
    const ids = Array.from(this.byShortId.keys());
    const last = ids[ids.length - 1];
    if (!last) throw new Error("no pending confirms");
    this.drive(last, decision);
  }
}

class CapturingSink implements Sink {
  events: ChannelEvent[] = [];
  async send(event: ChannelEvent): Promise<void> {
    this.events.push(event);
  }
}

function callConfirm(
  tool: ReturnType<typeof defineConfirmTool>,
  args: { action: string; rationale: string; risk: string },
): Promise<ConfirmResult> {
  return tool.execute(args as Record<string, unknown>) as Promise<ConfirmResult>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defineConfirmTool", () => {
  test("user yes → approved=true with reason=user_yes", async () => {
    const reg = new FakePendingConfirms();
    const term = new CapturingSink();
    const tool = defineConfirmTool({
      pendingConfirms: reg,
      sinks: { terminal: term },
      getCurrentTaskId: () => "task-42",
    });

    const pending = callConfirm(tool, {
      action: "rm -rf ./build",
      rationale: "stale build dir",
      risk: "loses 30s of build cache",
    });

    // Wait a tick for the create() to land, then resolve.
    await new Promise((r) => setImmediate(r));
    reg.driveLatest("yes");

    const result = await pending;
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.reason).toBe("user_yes");
      expect(result.shortId).toMatch(/^T/);
    }
  });

  test("user no → approved=false with reason=user_no", async () => {
    const reg = new FakePendingConfirms();
    const term = new CapturingSink();
    const tool = defineConfirmTool({
      pendingConfirms: reg,
      sinks: { terminal: term },
      getCurrentTaskId: () => "task-43",
    });

    const pending = callConfirm(tool, {
      action: "git push --force",
      rationale: "fixed lint commit",
      risk: "rewrites public branch history",
    });

    await new Promise((r) => setImmediate(r));
    reg.driveLatest("no");

    const result = await pending;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("user_no");
    expect(result.shortId).not.toBeNull();
  });

  test("timeout → approved=false with reason=timeout", async () => {
    const reg = new FakePendingConfirms();
    const tool = defineConfirmTool({
      pendingConfirms: reg,
      sinks: { terminal: new CapturingSink() },
      getCurrentTaskId: () => "task-timeout",
    });

    const pending = callConfirm(tool, {
      action: "DROP DATABASE prod",
      rationale: "(none — should never approve)",
      risk: "irrecoverable data loss",
    });

    await new Promise((r) => setImmediate(r));
    reg.driveLatest("timeout");

    const result = await pending;
    expect(result.approved).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test("per-task cap (3) → 4th call returns task_blocked_confirm_cap immediately", async () => {
    // Pre-fill the registry with 3 unresolved confirms for the task so the
    // 4th attempt trips the cap pre-check without waiting on user input.
    const reg = new FakePendingConfirms(3);
    const term = new CapturingSink();
    const wa = new CapturingSink();
    const tool = defineConfirmTool({
      pendingConfirms: reg,
      sinks: { terminal: term, whatsapp: wa },
      getCurrentTaskId: () => "task-cap",
    });

    // Open 3 pending confirms — tool calls await user, so we don't await.
    const p1 = callConfirm(tool, { action: "a1", rationale: "r1", risk: "k1" });
    await new Promise((r) => setImmediate(r));
    const p2 = callConfirm(tool, { action: "a2", rationale: "r2", risk: "k2" });
    await new Promise((r) => setImmediate(r));
    const p3 = callConfirm(tool, { action: "a3", rationale: "r3", risk: "k3" });
    await new Promise((r) => setImmediate(r));

    expect(reg.countForTask("task-cap")).toBe(3);

    // 4th attempt — should NOT block on user; should return cap-hit immediately.
    const r4 = await callConfirm(tool, {
      action: "a4",
      rationale: "r4",
      risk: "k4",
    });
    expect(r4.approved).toBe(false);
    expect(r4.reason).toBe("task_blocked_confirm_cap");
    expect(r4.shortId).toBeNull();

    // The cap-hit emits a synthetic blocked-tell to all sinks.
    const blockedTells = [...term.events, ...wa.events].filter(
      (e) => e.type === "tell" && e.urgency === "blocked",
    );
    expect(blockedTells.length).toBeGreaterThan(0);

    // Cleanup the still-pending originals so vitest doesn't moan.
    reg.driveLatest("no");
    reg.driveLatest("no");
    reg.driveLatest("no");
    await Promise.all([p1, p2, p3]);
  });

  test("sends confirm_request event to all sinks", async () => {
    const reg = new FakePendingConfirms();
    const term = new CapturingSink();
    const wa = new CapturingSink();
    const tg = new CapturingSink();
    const tool = defineConfirmTool({
      pendingConfirms: reg,
      sinks: { terminal: term, whatsapp: wa, telegram: tg },
      getCurrentTaskId: () => "task-broadcast",
    });

    const pending = callConfirm(tool, {
      action: "rm -rf ~/.config/foo",
      rationale: "purge stale config",
      risk: "loses local-only foo settings",
    });

    await new Promise((r) => setImmediate(r));

    // Each sink should have observed the confirm_request before resolution.
    for (const s of [term, wa, tg]) {
      const e = s.events.find((x) => x.type === "confirm_request");
      expect(e).toBeDefined();
      if (e && e.type === "confirm_request") {
        expect(e.question).toBe("rm -rf ~/.config/foo");
        expect(e.rationale).toBe("purge stale config");
        expect(e.risk).toBe("loses local-only foo settings");
        expect(e.shortId).toMatch(/^T/);
      }
    }

    reg.driveLatest("yes");
    await pending;
  });

  test("returns shortId in result on yes/no (and the same id observed in the sent event)", async () => {
    const reg = new FakePendingConfirms();
    const term = new CapturingSink();
    const tool = defineConfirmTool({
      pendingConfirms: reg,
      sinks: { terminal: term },
      getCurrentTaskId: () => "task-id-match",
    });

    const pending = callConfirm(tool, {
      action: "delete S3 bucket",
      rationale: "old test bucket",
      risk: "loses ~10MB of test fixtures",
    });

    await new Promise((r) => setImmediate(r));
    const sent = term.events.find((e) => e.type === "confirm_request");
    expect(sent).toBeDefined();
    if (!sent || sent.type !== "confirm_request") throw new Error("no event");
    const sentShortId = sent.shortId;

    reg.driveLatest("yes");
    const result = await pending;
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.shortId).toBe(sentShortId);
    }
  });

  test("no active task → approved=false reason=no_active_task (does not even register)", async () => {
    const reg = new FakePendingConfirms();
    const term = new CapturingSink();
    const tool = defineConfirmTool({
      pendingConfirms: reg,
      sinks: { terminal: term },
      getCurrentTaskId: () => null,
    });

    const r = await callConfirm(tool, {
      action: "rm",
      rationale: "x",
      risk: "y",
    });
    expect(r.approved).toBe(false);
    expect(r.reason).toBe("no_active_task");
    expect(reg.countForTask("anything")).toBe(0);
    expect(term.events).toHaveLength(0);
  });
});
