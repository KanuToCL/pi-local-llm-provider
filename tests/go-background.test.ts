import { describe, expect, test } from "vitest";
import {
  defineGoBackgroundTool,
  type GoBackgroundResult,
  type TaskState,
  type TaskStateManager,
  type TryTransitionArgs,
} from "../src/tools/go-background.js";
import type { ChannelEvent, Sink } from "../src/tools/types.js";

// ---------------------------------------------------------------------------
// Test helpers — minimal in-memory TaskStateManager.
//
// Mirrors the contract IMPL-7 will satisfy at src/lib/task-state.ts.  Just
// enough to drive go_background: get() returns the current state, and
// tryTransition swaps to backgrounded if the from-task-id matches.
// ---------------------------------------------------------------------------

class FakeTaskState implements TaskStateManager {
  private state: TaskState;

  /** If set, the next tryTransition call will fail (simulates CAS race). */
  public forceCasFailOnce = false;
  /** Hook fired BEFORE tryTransition runs.  Lets a test mutate state mid-call. */
  public onTryTransition: ((args: TryTransitionArgs) => void) | null = null;

  constructor(initial: TaskState = { kind: "idle" }) {
    this.state = initial;
  }

  setState(state: TaskState): void {
    this.state = state;
  }

  get(): TaskState {
    return this.state;
  }

  tryTransition(args: TryTransitionArgs): { ok: boolean; reason?: string } {
    if (this.onTryTransition) this.onTryTransition(args);
    if (this.forceCasFailOnce) {
      this.forceCasFailOnce = false;
      return { ok: false, reason: "cas race (forced)" };
    }
    if (args.kind === "go_background") {
      if (this.state.kind !== "running") {
        return { ok: false, reason: `cannot go_background from ${this.state.kind}` };
      }
      if (this.state.taskId !== args.fromTaskId) {
        return { ok: false, reason: "task id drifted" };
      }
      this.state = {
        kind: "backgrounded",
        taskId: this.state.taskId,
        startedAt: this.state.startedAt,
        channel: this.state.channel,
        userMessage: this.state.userMessage,
        abort: this.state.abort,
        promotedAt: args.promotedAt,
        promotedBy: args.promotedBy,
      };
      return { ok: true };
    }
    return { ok: false, reason: "unknown transition" };
  }
}

class CapturingSink implements Sink {
  events: ChannelEvent[] = [];
  async send(event: ChannelEvent): Promise<void> {
    this.events.push(event);
  }
}

function runningState(overrides: Partial<TaskState & { kind: "running" }> = {}): TaskState {
  return {
    kind: "running",
    taskId: "task-running-1",
    startedAt: 1_700_000_000_000,
    channel: "whatsapp",
    userMessage: "refactor the worker pool to use a single GPU mutex",
    abort: new AbortController(),
    ...overrides,
  };
}

function callGo(
  tool: ReturnType<typeof defineGoBackgroundTool>,
  args: { rationale: string; estimatedRemainingSeconds?: number } = {
    rationale: "this is bigger than I thought",
  },
): Promise<GoBackgroundResult> {
  return tool.execute(args as Record<string, unknown>) as Promise<GoBackgroundResult>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defineGoBackgroundTool", () => {
  test("successful promotion: running → backgrounded, returns backgrounded=true", async () => {
    const ts = new FakeTaskState(runningState());
    const term = new CapturingSink();
    const wa = new CapturingSink();
    const tool = defineGoBackgroundTool({
      taskState: ts,
      sinks: { terminal: term, whatsapp: wa },
      now: () => 1_700_000_005_000,
    });

    const r = await callGo(tool);

    expect(r.backgrounded).toBe(true);
    if (r.backgrounded) {
      expect(r.promotedAt).toBe(1_700_000_005_000);
    }
    expect(ts.get().kind).toBe("backgrounded");
  });

  test("returns reason=not_running when state is idle", async () => {
    const ts = new FakeTaskState({ kind: "idle" });
    const tool = defineGoBackgroundTool({
      taskState: ts,
      sinks: { terminal: new CapturingSink() },
    });

    const r = await callGo(tool);
    expect(r.backgrounded).toBe(false);
    if (!r.backgrounded) {
      expect(r.reason).toBe("not_running");
    }
    expect(ts.get().kind).toBe("idle");
  });

  test("returns reason=not_running when state is completed/cancelled/failed", async () => {
    for (const state of [
      { kind: "completed", taskId: "t1", startedAt: 0, finishedAt: 1 },
      {
        kind: "cancelled",
        taskId: "t1",
        startedAt: 0,
        cancelledAt: 1,
        reason: "user",
      },
      { kind: "failed", taskId: "t1", startedAt: 0, finishedAt: 1, error: "x" },
      {
        kind: "backgrounded",
        taskId: "t1",
        startedAt: 0,
        channel: "terminal",
        userMessage: "msg",
        abort: new AbortController(),
        promotedAt: 1,
        promotedBy: "agent",
      },
    ] as const satisfies readonly TaskState[]) {
      const ts = new FakeTaskState(state);
      const tool = defineGoBackgroundTool({
        taskState: ts,
        sinks: { terminal: new CapturingSink() },
      });
      const r = await callGo(tool);
      expect(r.backgrounded).toBe(false);
      if (!r.backgrounded) {
        expect(r.reason).toBe("not_running");
      }
    }
  });

  test("returns reason=cas_failed if state changes mid-call", async () => {
    // Simulate a CAS race: state is `running` at get() time, but the
    // tryTransition fails because someone else (e.g. /cancel) won the race.
    const ts = new FakeTaskState(runningState());
    ts.forceCasFailOnce = true;
    const tool = defineGoBackgroundTool({
      taskState: ts,
      sinks: { terminal: new CapturingSink() },
    });

    const r = await callGo(tool);
    expect(r.backgrounded).toBe(false);
    if (!r.backgrounded) {
      expect(r.reason).toBe("cas_failed");
    }
    // State was NOT mutated (the simulated cancel/etc. would have done that
    // separately; we just assert THIS tool didn't transition).
    expect(ts.get().kind).toBe("running");
  });

  test("sends go_background_notice with the user message preview", async () => {
    const longMsg =
      "refactor the worker pool to use a single GPU mutex with backoff " +
      "and per-channel queues and remove the duplicate session manager " +
      "spawning and add proper teardown semantics please";
    const ts = new FakeTaskState(runningState({ userMessage: longMsg }));
    const term = new CapturingSink();
    const wa = new CapturingSink();
    const tool = defineGoBackgroundTool({
      taskState: ts,
      sinks: { terminal: term, whatsapp: wa },
      now: () => 1_700_000_007_777,
      previewChars: 80,
    });

    const r = await callGo(tool);
    expect(r.backgrounded).toBe(true);

    for (const sink of [term, wa]) {
      expect(sink.events).toHaveLength(1);
      const e = sink.events[0]!;
      expect(e.type).toBe("go_background_notice");
      if (e.type === "go_background_notice") {
        expect(e.ts).toBe(1_700_000_007_777);
        // preview clipped to <=80 chars (with the ellipsis taking one slot)
        expect(e.userMessagePreview.length).toBeLessThanOrEqual(80);
        // preview begins with the start of the user message
        expect(longMsg.startsWith(e.userMessagePreview.replace(/…$/, ""))).toBe(true);
      }
    }
  });
});
