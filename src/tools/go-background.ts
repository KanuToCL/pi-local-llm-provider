/**
 * `go_background()` tool — agent self-promote into background mode.
 *
 * Per plan §"Phase 1.5 v4.1 system prompt" + §"v4.3 tell()" + §"v4.2 v4.1
 * go_background()":
 *   - When pi realizes current work will take more than ~30s, it calls
 *     go_background() so the user isn't left waiting at the WhatsApp prompt.
 *   - Triggers the same "going to background" flow as the safety-net
 *     auto-promote, just earlier and with the agent's own framing.
 *   - State transition: TaskState `running` → `backgrounded` via CAS.
 *     If state is anything else (idle, completed, cancelled, failed) we
 *     refuse and return `reason: 'not_running'`.  If a competing transition
 *     wins the CAS race (e.g. user `/cancel` arrives the same tick), we
 *     return `reason: 'cas_failed'`.
 *
 * The TaskStateManager interface here is a STRUCTURAL stub of what IMPL-7
 * will own at `src/lib/task-state.ts`.  We don't import from there because
 * IMPL-7 ships in the same wave; both files compile in isolation against
 * this contract.
 */

import {
  type ChannelEvent,
  type DefinedTool,
  type Sink,
  type SinkBag,
  fanOut,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public — task-state contract that IMPL-7 will satisfy
// ---------------------------------------------------------------------------

/**
 * Mirrors plan §"Phase 1.5 — Type spec" line-for-line.  IMPL-7 owns the
 * canonical TaskState union; we redeclare here so this file compiles in
 * wave-isolation.  The shape MUST match.
 */
export type TaskState =
  | { kind: "idle" }
  | {
      kind: "running";
      taskId: string;
      startedAt: number;
      channel: "terminal" | "whatsapp" | "telegram";
      userMessage: string;
      abort: AbortController;
    }
  | {
      kind: "backgrounded";
      taskId: string;
      startedAt: number;
      channel: "terminal" | "whatsapp" | "telegram";
      userMessage: string;
      abort: AbortController;
      promotedAt: number;
      promotedBy: "agent" | "auto";
    }
  | {
      kind: "completed";
      taskId: string;
      startedAt: number;
      finishedAt: number;
    }
  | {
      kind: "cancelled";
      taskId: string;
      startedAt: number;
      cancelledAt: number;
      reason: "user" | "studio_crash" | "timeout" | "shutdown" | "confirm_cap";
    }
  | {
      kind: "failed";
      taskId: string;
      startedAt: number;
      finishedAt: number;
      error: string;
    };

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

export interface TaskStateManager {
  /** Snapshot the current state.  Plan §"Phase 1.5" requires reads to be
   *  atomic — the returned object MUST NOT mutate. */
  get(): TaskState;
  /**
   * Atomic compare-and-set.  IMPL-7 implements this via a single in-memory
   * mutex / monotonic counter; we just need the contract: it returns
   * `{ ok: true }` if the transition succeeded, `{ ok: false, reason }` if
   * the FROM state had drifted (CAS-fail) or the transition is illegal
   * per plan's allowed-transition table.
   *
   * The argument shape is "from-state's taskId or 'idle' AND target-state".
   * IMPL-7 may widen this; we use the shape that's load-bearing for
   * go_background.
   */
  tryTransition(args: TryTransitionArgs): TransitionResult;
}

export type TryTransitionArgs =
  | {
      kind: "go_background";
      fromTaskId: string;
      promotedAt: number;
      promotedBy: "agent" | "auto";
    }
  // NOTE: IMPL-7 will define the full set; this file only needs the
  // go_background variant.  Other variants (complete/cancel/fail) are
  // owned by their respective consumers (daemon completion handler, /cancel
  // command, error path).
  ;

// ---------------------------------------------------------------------------
// Public — defineGoBackgroundTool options
// ---------------------------------------------------------------------------

/** Go-background-specific sink bag.  See `TellSinks` for SinkBag-compat note. */
export type GoBackgroundSinks = SinkBag & {
  terminal?: Sink;
  whatsapp?: Sink;
  telegram?: Sink;
};

export interface DefineGoBackgroundToolOptions {
  taskState: TaskStateManager;
  sinks: GoBackgroundSinks;
  /** Override for time source — primarily for tests. */
  now?: () => number;
  /** Max chars of userMessage to include in the go_background_notice
   *  preview.  Defaults to 80 (one phone-line ish). */
  previewChars?: number;
}

// ---------------------------------------------------------------------------
// Public — result shape
// ---------------------------------------------------------------------------

export type GoBackgroundResult =
  | { backgrounded: true; promotedAt: number }
  | {
      backgrounded: false;
      reason: "not_running" | "cas_failed";
    };

// ---------------------------------------------------------------------------
// Public — factory
// ---------------------------------------------------------------------------

const DEFAULT_PREVIEW_CHARS = 80;

export function defineGoBackgroundTool(
  opts: DefineGoBackgroundToolOptions,
): DefinedTool {
  const now = opts.now ?? Date.now;
  const previewChars = opts.previewChars ?? DEFAULT_PREVIEW_CHARS;

  return {
    name: "go_background",
    description: [
      "Promote the current task to background mode so the user isn't left",
      "waiting at the WhatsApp prompt.",
      "",
      "Call this when you realize the current work will take more than ~30",
      "seconds. Sergio will get a 'going async, will ping when done' notice;",
      "the framework will auto-send your final answer when you complete.",
      "",
      "If you forget, the daemon's safety-net auto-promote will fire after",
      "~30s and post a generic 'still working' message — your tailored",
      "rationale here is better.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["rationale"],
      properties: {
        rationale: {
          type: "string",
          description:
            "One-sentence reason for going async (e.g. 'this is a 5-file " +
            "refactor, will take a few minutes').",
        },
        estimatedRemainingSeconds: {
          type: "number",
          description:
            "Optional rough estimate of remaining work in seconds.  Helps " +
            "Sergio decide whether to wait or move on.",
        },
      },
    },
    async execute(_args): Promise<GoBackgroundResult> {
      // ---- Snapshot the current state ----
      const current = opts.taskState.get();
      if (current.kind !== "running") {
        return { backgrounded: false, reason: "not_running" };
      }

      const promotedAt = now();
      const transition = opts.taskState.tryTransition({
        kind: "go_background",
        fromTaskId: current.taskId,
        promotedAt,
        promotedBy: "agent",
      });
      if (!transition.ok) {
        // CAS race: state changed between our snapshot and the transition
        // attempt (e.g. /cancel arrived this tick).  Refuse cleanly; the
        // agent's loop will see the result and stop trying to background.
        return { backgrounded: false, reason: "cas_failed" };
      }

      // ---- Emit the go_background_notice to every configured sink ----
      const event: ChannelEvent = {
        type: "go_background_notice",
        userMessagePreview: clipPreview(current.userMessage, previewChars),
        ts: promotedAt,
      };
      await fanOut(opts.sinks, event);

      return { backgrounded: true, promotedAt };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function clipPreview(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…"; // ellipsis
}
