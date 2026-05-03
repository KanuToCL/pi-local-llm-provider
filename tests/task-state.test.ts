/**
 * Tests for `src/lib/task-state.ts`.
 *
 * Coverage targets (per IMPL-7 brief, ≥12 cases):
 *   - All 11 valid transitions return ok
 *   - All ~25 invalid transitions return ok=false with descriptive reason
 *   - `TaskStateManager` persists across reset (write to file →
 *     re-instantiate from same path → state preserved)
 *   - `restoreFromDisk` force-transitions running/backgrounded → idle and
 *     signals abandonment (per plan §"Phase 1.5 cross-restart persistence",
 *     line 1070-1073)
 *   - Race-suppression: if state has advanced past expected, `tryTransition`
 *     returns ok=false (this is the auto-promote race guard from
 *     §"Phase 1.5 type spec" line 1044)
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TaskState,
  TaskStateManager,
  transition,
  type ChannelId,
} from "../src/lib/task-state.js";
import { JsonStore } from "../src/storage/json-store.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-taskstate-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Test fixture builders. AbortController is intentionally a fresh instance
// per state — tests should not rely on cross-state controller equality.
function idle(): TaskState {
  return { kind: "idle" };
}

function running(taskId = "T1", channel: ChannelId = "telegram"): TaskState {
  return {
    kind: "running",
    taskId,
    startedAt: 1_000,
    channel,
    userMessage: "do the thing",
    abort: new AbortController(),
  };
}

function backgrounded(
  taskId = "T1",
  promotedBy: "agent" | "auto" = "auto"
): TaskState {
  return {
    kind: "backgrounded",
    taskId,
    startedAt: 1_000,
    channel: "telegram",
    userMessage: "do the thing",
    abort: new AbortController(),
    promotedAt: 2_000,
    promotedBy,
  };
}

function completed(taskId = "T1"): TaskState {
  return {
    kind: "completed",
    taskId,
    startedAt: 1_000,
    finishedAt: 3_000,
  };
}

function cancelled(
  taskId = "T1",
  reason:
    | "user"
    | "studio_crash"
    | "timeout"
    | "shutdown"
    | "confirm_cap" = "user"
): TaskState {
  return {
    kind: "cancelled",
    taskId,
    startedAt: 1_000,
    cancelledAt: 4_000,
    reason,
  };
}

function failed(taskId = "T1"): TaskState {
  return {
    kind: "failed",
    taskId,
    startedAt: 1_000,
    finishedAt: 5_000,
    error: "boom",
  };
}

describe("transition() — valid edges", () => {
  test("idle → running", () => {
    expect(transition(idle(), running()).ok).toBe(true);
  });

  test("running → backgrounded", () => {
    expect(transition(running(), backgrounded()).ok).toBe(true);
  });

  test("running → completed", () => {
    expect(transition(running(), completed()).ok).toBe(true);
  });

  test("running → cancelled", () => {
    expect(transition(running(), cancelled()).ok).toBe(true);
  });

  test("running → failed", () => {
    expect(transition(running(), failed()).ok).toBe(true);
  });

  test("backgrounded → completed", () => {
    expect(transition(backgrounded(), completed()).ok).toBe(true);
  });

  test("backgrounded → cancelled", () => {
    expect(transition(backgrounded(), cancelled()).ok).toBe(true);
  });

  test("backgrounded → failed", () => {
    expect(transition(backgrounded(), failed()).ok).toBe(true);
  });

  test("completed → idle", () => {
    expect(transition(completed(), idle()).ok).toBe(true);
  });

  test("cancelled → idle", () => {
    expect(transition(cancelled(), idle()).ok).toBe(true);
  });

  test("failed → idle", () => {
    expect(transition(failed(), idle()).ok).toBe(true);
  });
});

describe("transition() — invalid edges", () => {
  test("idle → backgrounded is rejected with descriptive reason", () => {
    const r = transition(idle(), backgrounded());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid transition idle → backgrounded/);
  });

  test("idle → completed is rejected", () => {
    expect(transition(idle(), completed()).ok).toBe(false);
  });

  test("idle → cancelled is rejected", () => {
    expect(transition(idle(), cancelled()).ok).toBe(false);
  });

  test("idle → failed is rejected", () => {
    expect(transition(idle(), failed()).ok).toBe(false);
  });

  test("idle → idle is rejected (no self-loops)", () => {
    expect(transition(idle(), idle()).ok).toBe(false);
  });

  test("running → idle is rejected (must terminal-state first)", () => {
    expect(transition(running(), idle()).ok).toBe(false);
  });

  test("running → running is rejected", () => {
    expect(transition(running(), running()).ok).toBe(false);
  });

  test("backgrounded → idle is rejected", () => {
    expect(transition(backgrounded(), idle()).ok).toBe(false);
  });

  test("backgrounded → running is rejected", () => {
    expect(transition(backgrounded(), running()).ok).toBe(false);
  });

  test("backgrounded → backgrounded is rejected", () => {
    expect(transition(backgrounded(), backgrounded()).ok).toBe(false);
  });

  test("completed → running is rejected (must drain to idle)", () => {
    expect(transition(completed(), running()).ok).toBe(false);
  });

  test("completed → backgrounded is rejected", () => {
    expect(transition(completed(), backgrounded()).ok).toBe(false);
  });

  test("completed → cancelled is rejected", () => {
    expect(transition(completed(), cancelled()).ok).toBe(false);
  });

  test("completed → completed is rejected", () => {
    expect(transition(completed(), completed()).ok).toBe(false);
  });

  test("completed → failed is rejected", () => {
    expect(transition(completed(), failed()).ok).toBe(false);
  });

  test("cancelled → running is rejected", () => {
    expect(transition(cancelled(), running()).ok).toBe(false);
  });

  test("cancelled → backgrounded is rejected", () => {
    expect(transition(cancelled(), backgrounded()).ok).toBe(false);
  });

  test("cancelled → completed is rejected", () => {
    expect(transition(cancelled(), completed()).ok).toBe(false);
  });

  test("cancelled → failed is rejected", () => {
    expect(transition(cancelled(), failed()).ok).toBe(false);
  });

  test("cancelled → cancelled is rejected", () => {
    expect(transition(cancelled(), cancelled()).ok).toBe(false);
  });

  test("failed → running is rejected", () => {
    expect(transition(failed(), running()).ok).toBe(false);
  });

  test("failed → backgrounded is rejected", () => {
    expect(transition(failed(), backgrounded()).ok).toBe(false);
  });

  test("failed → completed is rejected", () => {
    expect(transition(failed(), completed()).ok).toBe(false);
  });

  test("failed → cancelled is rejected", () => {
    expect(transition(failed(), cancelled()).ok).toBe(false);
  });

  test("failed → failed is rejected", () => {
    expect(transition(failed(), failed()).ok).toBe(false);
  });
});

describe("TaskStateManager", () => {
  test("starts at { kind: 'idle' } when no persistence path provided", () => {
    const mgr = new TaskStateManager();
    expect(mgr.get().kind).toBe("idle");
  });

  test("tryTransition mutates internal state on valid transition", () => {
    const mgr = new TaskStateManager();
    const next = running();
    const r = mgr.tryTransition(next);
    expect(r.ok).toBe(true);
    expect(mgr.get().kind).toBe("running");
  });

  test("tryTransition leaves state unchanged on invalid transition", () => {
    const mgr = new TaskStateManager();
    // idle → backgrounded is invalid
    const r = mgr.tryTransition(backgrounded());
    expect(r.ok).toBe(false);
    expect(mgr.get().kind).toBe("idle");
  });

  test("persists state to disk on every transition", async () => {
    const path = join(workDir, "task-state.json");
    const mgr = new TaskStateManager({ persistencePath: path });

    mgr.tryTransition(running("TASK-A"));
    // Wait for the queued write to drain.
    await mgr.flush();

    const store = new JsonStore<unknown>(path);
    const persisted = await store.read();
    expect(persisted).toBeTruthy();
    expect((persisted as { kind: string }).kind).toBe("running");
    expect((persisted as { taskId: string }).taskId).toBe("TASK-A");
  });

  test("AbortController is NOT persisted (non-serializable)", async () => {
    const path = join(workDir, "task-state.json");
    const mgr = new TaskStateManager({ persistencePath: path });
    mgr.tryTransition(running("TASK-X"));
    await mgr.flush();
    const store = new JsonStore<unknown>(path);
    const raw = (await store.read()) as Record<string, unknown>;
    // The persisted snapshot should not contain a live AbortController;
    // it is intentionally stripped on serialization.
    expect(raw.abort).toBeUndefined();
  });

  test("restoreFromDisk returns idle when no prior state exists", async () => {
    const path = join(workDir, "task-state.json");
    const mgr = new TaskStateManager({ persistencePath: path });
    const restored = await mgr.restoreFromDisk();
    expect(restored.priorState.kind).toBe("idle");
    expect(restored.abandoned).toBeNull();
    expect(mgr.get().kind).toBe("idle");
  });

  test("restoreFromDisk force-transitions running → idle and signals abandonment", async () => {
    const path = join(workDir, "task-state.json");

    // First daemon: started a task, persisted, "crashed" mid-task.
    const m1 = new TaskStateManager({ persistencePath: path });
    m1.tryTransition(running("ABANDONED-TASK", "whatsapp"));
    await m1.flush();

    // Second daemon: restart, restore from disk.
    const m2 = new TaskStateManager({ persistencePath: path });
    const restored = await m2.restoreFromDisk();
    await m2.flush();

    expect(restored.priorState.kind).toBe("running");
    expect(restored.abandoned).not.toBeNull();
    expect(restored.abandoned!.taskId).toBe("ABANDONED-TASK");
    expect(restored.abandoned!.channel).toBe("whatsapp");
    expect(restored.abandoned!.userMessage).toBe("do the thing");
    // Manager state has been forced to idle so the daemon can accept
    // new tasks.
    expect(m2.get().kind).toBe("idle");
  });

  test("restoreFromDisk force-transitions backgrounded → idle and signals abandonment", async () => {
    const path = join(workDir, "task-state.json");
    const m1 = new TaskStateManager({ persistencePath: path });
    m1.tryTransition(running("BG-ABAND"));
    m1.tryTransition(backgrounded("BG-ABAND", "agent"));
    await m1.flush();

    const m2 = new TaskStateManager({ persistencePath: path });
    const restored = await m2.restoreFromDisk();
    await m2.flush();
    expect(restored.priorState.kind).toBe("backgrounded");
    expect(restored.abandoned).not.toBeNull();
    expect(restored.abandoned!.taskId).toBe("BG-ABAND");
    expect(m2.get().kind).toBe("idle");
  });

  test("restoreFromDisk does NOT signal abandonment when prior state was terminal", async () => {
    const path = join(workDir, "task-state.json");
    const m1 = new TaskStateManager({ persistencePath: path });
    m1.tryTransition(running("DONE"));
    m1.tryTransition(completed("DONE"));
    await m1.flush();

    const m2 = new TaskStateManager({ persistencePath: path });
    const restored = await m2.restoreFromDisk();
    await m2.flush();
    expect(restored.priorState.kind).toBe("completed");
    expect(restored.abandoned).toBeNull();
    // After restore, manager goes to idle (drains the terminal state)
    // so the daemon can accept new work.
    expect(m2.get().kind).toBe("idle");
  });

  test("restoreFromDisk handles corrupt/missing state by resetting to idle", async () => {
    const path = join(workDir, "task-state.json");
    // Manually write garbage; JsonStore will quarantine and return null.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{not json", "utf8");
    const mgr = new TaskStateManager({ persistencePath: path });
    const restored = await mgr.restoreFromDisk();
    expect(restored.priorState.kind).toBe("idle");
    expect(restored.abandoned).toBeNull();
    expect(mgr.get().kind).toBe("idle");
  });

  test("race-suppression: tryTransition fails when state has advanced past 'from'", () => {
    // This is the auto-promote race guard. The auto-promote timer captures
    // a taskId at fire time and tries `running → backgrounded` for THAT
    // task. If the task has already completed (state advanced past
    // 'running'), the transition must fail so no spurious auto-promote
    // message is sent. Per plan §"Phase 1.5" lines 1042-1050.
    const mgr = new TaskStateManager();
    mgr.tryTransition(running("RACE-TASK"));
    // The task races to completion before the auto-promote timer fires.
    mgr.tryTransition(completed("RACE-TASK"));
    // Now the auto-promote timer fires:
    const r = mgr.tryTransition(backgrounded("RACE-TASK", "auto"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/invalid transition completed → backgrounded/);
  });

  test("works with a caller-provided JsonStore (DI for tests)", async () => {
    const path = join(workDir, "custom.json");
    const store = new JsonStore<unknown>(path);
    const mgr = new TaskStateManager({ jsonStore: store });
    mgr.tryTransition(running("X"));
    await mgr.flush();
    const persisted = (await store.read()) as { kind: string };
    expect(persisted.kind).toBe("running");
  });
});
