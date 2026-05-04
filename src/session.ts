/**
 * SessionManager — the integrator. Wires W1+W2 (config, system-prompt,
 * task-state, tools, sandbox, classifier, audit) into pi-mono's
 * `createAgentSession` via `customTools` + `session.subscribe()`.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"Architectural revision (Option C)" (lines 846-948): single shared
 *     session, framework-auto-completion, single-in-flight task.
 *   - §"Phase -1 SDK spike" (line 976): pi-mono ≥0.72 exposes
 *     `createAgentSession` + `defineTool` + `customTools`. NO
 *     `pi.registerTool`. We use `customTools` to inject our four tools
 *     (sandboxed-bash, tell, confirm, go_background).
 *   - §"Phase 1.5 — Single In-Flight Task" (line 1002): TaskStateManager
 *     CAS, auto-promote setTimeout with CAS guard, restore-from-disk on boot.
 *   - §"Sandbox primitive — wrap-bash" (lines 1430-1465): `defineSandboxedBashTool`
 *     replaces pi-mono's default bash entirely (we cannot intercept; we
 *     replace).
 *   - §"v4.2 Decision tree" (line 1481, post-abort-callback row): TaskState
 *     CAS guards filter ALL post-abort() events at daemon level — do NOT
 *     trust pi-mono. Every sink emit goes through a `taskState.kind !==
 *     'cancelled'` check.
 *   - §"Schema-drift detection" (lines 1224-1228): validate models.json on
 *     init; refuse to start with structured error if pi-mono's schema drift.
 *
 * Architectural boundaries:
 *   - SessionManager OWNS: SDK lifecycle (load/init/dispose), event
 *     subscription, auto-promote timer + CAS guard, inbound message routing
 *     into the GlobalQueue, sink fan-out for events SessionManager generates
 *     (auto_promote_notice, framework-auto-completion `tell`).
 *   - SessionManager DOES NOT OWN: channel transport (IMPL-12), slash-command
 *     parsing (IMPL-14), IPC verbs (IMPL-13), daemon process lifecycle
 *     (IMPL-W4). It exposes `handleInbound()` / `dispose()` and the daemon
 *     orchestrator wires those into the channel layer.
 *
 * Cross-restart recovery:
 *   - On `init()`, `taskState.restoreFromDisk()` is called. If a task was
 *     `running` or `backgrounded` at the time of the previous shutdown, we
 *     emit a recovery `tell()` to the originating channel describing the
 *     abandoned request and force the manager into `idle`. Audit event
 *     `task_abandoned_on_restart` is logged so post-incident review can
 *     correlate.
 */

import { createHash, randomBytes } from "node:crypto";

import type { AppConfig } from "./config.js";
import { GlobalQueue } from "./lib/chat-queue.js";
import {
  type SdkAgentSession,
  type SdkLoaded,
  loadSdk,
  mapAgentEventToChannelEvent,
} from "./lib/sdk-shim.js";
import { loadAndValidateModelsJson } from "./lib/sdk-models-validator.js";
import { composeSystemPrompt } from "./lib/system-prompt.js";
import {
  type ChannelId,
  type TaskState,
  TaskStateManager,
} from "./lib/task-state.js";
import { defineSandboxedBashTool } from "./sandbox/wrap-bash.js";
import { classify } from "./guards/classifier.js";
import type { SandboxPolicy } from "./sandbox/policy.js";
import type { AuditLog } from "./audit/log.js";
import type { OperatorLogger } from "./utils/operator-logger.js";
import {
  type Sink,
  type ChannelEvent,
  type SinkBag,
  fanOut,
} from "./tools/types.js";
import { defineTellTool } from "./tools/tell.js";
import {
  defineConfirmTool,
  type PendingConfirmsRegistry as ConfirmToolRegistryContract,
} from "./tools/confirm.js";
import { defineGoBackgroundTool } from "./tools/go-background.js";
import { PendingConfirmsRegistry } from "./tools/pending-confirms.js";
import { redactCredentialShapes } from "./lib/sanitize.js";

// ---------------------------------------------------------------------------
// Public — inbound message + sink bag
// ---------------------------------------------------------------------------

/**
 * Inbound user message routed by a channel adapter into the daemon. The
 * daemon (IMPL-W4) wraps each adapter callback into this shape and calls
 * `SessionManager.handleInbound`.
 */
export interface InboundMessage {
  channel: ChannelId;
  /** Raw text. SessionManager does not redact; channel layer + audit log
   *  handle PII-aware logging upstream. */
  text: string;
  /** Best-effort sender id (already hashed if the channel needs it). Used
   *  only for operator logger output here. */
  senderId?: string;
}

/** Sink bag indexed by ChannelId. SessionManager treats every entry as a
 *  best-effort send; failures are recorded but do not abort fan-out. */
export interface SessionSinks {
  whatsapp?: Sink;
  telegram?: Sink;
  terminal?: Sink;
}

// ---------------------------------------------------------------------------
// Public — SessionManager construction
// ---------------------------------------------------------------------------

export interface SessionManagerOpts {
  config: AppConfig;
  taskState: TaskStateManager;
  pendingConfirms: PendingConfirmsRegistry;
  sandboxPolicy: SandboxPolicy;
  auditLog: AuditLog;
  operatorLogger?: OperatorLogger;
  sinks: SessionSinks;
  /** GPU-bound serializer. Defaults to a fresh `GlobalQueue` if omitted. */
  globalQueue?: GlobalQueue;
  /** Path to the SHA-pinned base prompt. Defaults to `prompts/coding-agent.v2.txt`
   *  (v2 added the explicit Default Response Mode rule for small models that
   *  treat every available tool as something they MUST call — see plan v2
   *  Phase A). The default flips with every prompt rev; bump the v-number and
   *  the SHA pin in `tests/system-prompt.test.ts` together. */
  basePromptPath?: string;
  /**
   * Optional callback fired whenever pi-mono shows life — at message_start /
   * message_end / tool_execution_start events.  The daemon (IMPL-19) wires
   * this into the Heartbeat as the `pi-ping` source so a deadlocked
   * daemon's Node event loop cannot fool the dead-man switch.  Best-effort;
   * failures in the callback are swallowed so a heartbeat hiccup never
   * breaks the agent stream.
   */
  onPiActivity?: () => void;
  /**
   * Optional callback fired by the tell-tool every time it successfully
   * fans out to at least one sink.  The daemon uses this to refresh the
   * `lockState.lastTellAt` field surfaced by `/status`.
   */
  onTellEmit?: (ts: number) => void;
  /** Optional path to the status pointer file (composed into system prompt). */
  pointerPath?: string;
  /** Pointer body cap in graphemes. Defaults to 2000 per Data Guardian. */
  pointerSizeCap?: number;
  /** Optional injectable SDK loader (for tests — substitute a mock). */
  loadSdkOverride?: () => Promise<SdkLoaded>;
  /** Optional injectable models.json loader (for tests). Returns void on
   *  successful validation; throws on failure. */
  validateModelsJsonOverride?: (path: string) => Promise<void>;
  /**
   * Optional probe: returns true when the configured Studio model is
   * loaded and ready to serve a prompt.  Used by Pitfall #20 cold-start
   * suppression: if false, the auto-promote is deferred and a "warming
   * up" notice goes out instead.  Implementation in production hits
   * `GET <studio-url>/api/inference/status` and checks `loaded[]`.  For
   * tests, a mock returning a controllable boolean.  When omitted (or
   * thrown), cold-start gating is skipped — the auto-promote fires
   * normally per v3 behavior.
   */
  isStudioModelLoaded?: () => Promise<boolean>;
  /**
   * Maximum number of cold-start "warming up" reschedules before the
   * auto-promote fires regardless.  Per Pitfall #20: 5 attempts with
   * +30s spacing = 2.5 minutes of patience.  Each attempt emits one
   * `system_notice` "warming up" event so the user knows pi is alive.
   */
  coldStartMaxRetries?: number;
  /**
   * Delay between cold-start retries (ms).  Default 30s per Pitfall #20.
   */
  coldStartRetryMs?: number;
  /** Max duration (ms) a task can stay running/backgrounded before the
   *  watchdog force-completes it. Defaults to 5 min (300_000 ms).  Adversarial
   *  Round 2: defense-in-depth against pi-mono builds where neither agent_end
   *  nor message_end fires (network stall, SDK throw, compaction wedge that
   *  the null-mapper symmetry doesn't catch).  On expiry the in-flight task
   *  transitions to `failed` with reason `watchdog_no_terminal_event`, a
   *  `system_notice` is fanned out to the originating channel, and an audit
   *  entry is appended.  Tests use a shorter value (e.g. 100ms). */
  taskWatchdogMs?: number;
  /**
   * Soft Studio model-swap detection (plan v2 IMPL-D Step D.7).
   *
   * Optional callback that re-probes Studio for its currently-loaded model
   * IDs.  Returns the loaded[] array (typically length 1, but Studio
   * supports multi-load) or null on failure.  When provided AND
   * `coldStartModelId` is also provided, SessionManager fires the probe
   * (fire-and-forget) on every inbound and emits a one-shot
   * `system_notice` if the cold-start model is no longer in the loaded
   * set.  Hardening: multi-load semantics, per-channel cooldown,
   * post-abort gate, audit-log entry, studio-empty distinct alarm.
   *
   * Wired by daemon.ts to `getStudioLoadedModelIds` (IMPL-E Wave 3).
   */
  getStudioLoadedModelIds?: () => Promise<readonly string[] | null>;
  /**
   * Studio's loaded model id captured at boot.  Used as the comparison
   * point for the soft-swap detector.  When null/undefined, the detector
   * is dormant.
   */
  coldStartModelId?: string | null;
  /** Time source (ms). Defaults to Date.now. */
  now?: () => number;
  /** setTimeout function (for fake-timer tests). Defaults to global setTimeout. */
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  /** clearTimeout function (for fake-timer tests). Defaults to global clearTimeout. */
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * Auto-promote re-arm schedule, per plan v4.1 message catalog:
 *   - First fire at t=30s (configurable via `piCommsAutoPromoteMs`)
 *   - Second fire at t=2min (90s after first)
 *   - Third+ fires every 5min (300s between fires)
 *
 * Index 0 = delay from task start (uses `piCommsAutoPromoteMs`).
 * Index 1 = delay from FIRST fire (90s).
 * Index 2+ = delay from PREVIOUS fire (300s, capped).
 */
const AUTO_PROMOTE_RE_ARM_DELAYS_MS = [
  // index 0 is config.piCommsAutoPromoteMs (typically 30_000); used for the first fire only
  90_000, // gap from fire 1 → fire 2 (so fire 2 is at t=2min)
  300_000, // gap fire 2 → 3
  300_000, // gap fire 3 → 4 (cap)
];

// ---------------------------------------------------------------------------
// Public — SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly opts: SessionManagerOpts;
  private readonly globalQueue: GlobalQueue;
  private readonly now: () => number;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private sdk: SdkLoaded | null = null;
  private session: SdkAgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private autoPromoteHandle: unknown = null;
  /** Task id the active auto-promote schedule is bound to.  null when
   *  no schedule is active.  Used as a CAS guard inside fireAutoPromote
   *  so a captured timer handler that fires AFTER `clearAutoPromote()`
   *  (e.g. tests holding the handler reference) is suppressed. */
  private autoPromoteTaskId: string | null = null;
  /** Number of auto-promote fires recorded so far for the current task.
   *  Cleared when `clearAutoPromote()` runs (task completion / cancel /
   *  fail). */
  private autoPromoteFiringNumber = 0;
  /** Cold-start retry counter for the current task.  Cleared when
   *  `clearAutoPromote()` runs. */
  private autoPromoteColdRetries = 0;
  /** TaskState watchdog timer handle (plan v2 IMPL-D Step D.4).  Set when a
   *  task transitions to running; cleared on completion / cancel / fail. */
  private watchdogHandle: unknown = null;
  /** Task id the watchdog is bound to — CAS guard for late firings. */
  private watchdogTaskId: string | null = null;
  /** Soft-swap detector state (plan v2 IMPL-D Step D.7).
   *  `lastSwapNoticeModelId` — last model ID we surfaced via swap notice
   *  (one-shot suppression).  `lastSwapNoticeAt` — per-channel timestamp of
   *  last swap notice, used for the 60s cooldown. */
  private lastSwapNoticeModelId: string | null = null;
  // INVARIANT: bounded by ChannelId union cardinality (currently 3:
  // terminal/whatsapp/telegram). If ChannelId becomes per-conversation
  // (e.g. per-DM-thread IDs), add an LRU cap to prevent unbounded growth.
  private lastSwapNoticeAt: Map<ChannelId, number> = new Map();
  /** Adapter wrapping pending-confirms.ts to satisfy confirm.ts's interface. */
  private confirmRegistryAdapter: ConfirmToolRegistryContract | null = null;

  // tell-tool dedup state held here so cooldowns survive across multiple
  // `handleInbound` calls (per plan §"Pitfall #27").
  private readonly tellCooldownMap = new Map<string, number>();

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
    this.globalQueue = opts.globalQueue ?? new GlobalQueue();
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Boot the manager:
   *   1. Validate models.json (per §"Schema-drift detection").
   *   2. Restore task state from disk; emit recovery `tell()` if a task was
   *      abandoned mid-flight.
   *   3. Load pi-mono SDK.
   *   4. Build the four custom tools (bash + tell + confirm + go_background).
   *   5. Compose system prompt from base + status pointer.
   *   6. Call `createAgentSession({ customTools, ... })`.
   *   7. Subscribe to session events; route framework-auto-completion via
   *      `mapAgentEventToChannelEvent` to the originating channel.
   *
   * Throws `ConfigurationError` (from sdk-models-validator) or
   * `SdkNotInstalledError` (from sdk-shim) — callers should catch by name
   * and surface a structured operator diagnostic.
   */
  async init(): Promise<void> {
    const validate =
      this.opts.validateModelsJsonOverride ??
      (async (p: string) => {
        await loadAndValidateModelsJson(p);
      });
    await validate(this.opts.config.piModelsJson);

    // Restore state — must precede SDK load because if a task was abandoned,
    // the recovery tell() can't go through the agent (no session yet); it
    // goes directly to the originating channel sink.
    const restore = await this.opts.taskState.restoreFromDisk();
    if (restore.abandoned) {
      const ab = restore.abandoned;
      await this.opts.auditLog
        .append({
          event: "task_abandoned_on_restart",
          task_id: ab.taskId,
          channel: ab.channel,
          sender_id_hash: null,
          extra: {
            started_at: ab.startedAt,
          },
        })
        .catch(() => undefined);
      const sink = this.sinkFor(ab.channel);
      if (sink) {
        const preview = clipPreview(ab.userMessage, 80);
        const event: ChannelEvent = {
          type: "tell",
          urgency: "blocked",
          text: `pi: I crashed mid-task; the previous request was: ${preview} — please re-issue if still needed.`,
          ts: this.now(),
        };
        await sink.send(event).catch(() => undefined);
      }
    }

    const loader = this.opts.loadSdkOverride ?? loadSdk;
    this.sdk = await loader();

    const customTools = this.buildCustomTools(this.sdk);

    // Compose system prompt at boot time from the SHA-pinned base + the
    // optional status pointer. We compose it for SDK consumption only;
    // pi-mono accepts the prompt via its resource-loader subsystem, which
    // SessionManager does not touch directly. The prompt content is logged
    // via the operator logger so the operator can see what we're feeding
    // pi-mono on this boot.
    const promptPath =
      this.opts.basePromptPath ?? "prompts/coding-agent.v2.txt";
    const promptText = composeSystemPrompt({
      basePromptPath: promptPath,
      pointerPath: this.opts.pointerPath,
      pointerSizeCap: this.opts.pointerSizeCap ?? 2000,
    });
    this.opts.operatorLogger?.debug("session_recreate", {
      prompt_chars: promptText.length,
      tools: customTools.length,
    });

    // Plan v2 IMPL-D Step D.6 (PE Skeptic W2 + Observability W3): emit a
    // forensic-trail audit entry + operator-log entry for the prompt that
    // was loaded.  The basePromptPath flip (v1 → v2) silently changes
    // agent behavior; without this, an operator on the production box
    // can't tell which prompt is in flight from the boot screenshot.  The
    // audit-schema entry `prompt_version_changed` already exists at
    // src/audit/schema.ts:113 (added in IMPL-A).
    const promptSha8 = createHash("sha256")
      .update(promptText, "utf8")
      .digest("hex")
      .slice(0, 8);
    this.opts.operatorLogger?.info("prompt_version_changed", {
      path: promptPath,
      sha256_first8: promptSha8,
    });
    void this.opts.auditLog
      .append({
        event: "prompt_version_changed",
        task_id: null,
        channel: "system",
        sender_id_hash: null,
        extra: { path: promptPath, sha256_first8: promptSha8 },
      })
      .catch(() => undefined);

    const result = await this.sdk.createAgentSession({
      cwd: this.opts.config.piCommsWorkspace,
      customTools,
    });
    this.session = result.session;

    // AUDIT-C #8: pi-mono customTools[name='bash'] override assumption.
    // The plan assumes `customTools` with a tool named `bash` REPLACES
    // pi-mono's default bash entirely.  This cannot be verified without
    // an installed pi-mono on a Windows production box (the spike rig
    // covers Probe 5 — `tool_call_interception`).  Until that integration
    // test exists, surface a one-line WARN at boot so post-incident
    // review sees the assumption in context.
    this.opts.operatorLogger?.error("classifier_block", {
      reason:
        "ASSUMPTION: pi-mono customTools[name='bash'] overrides default; " +
        "verify by spike on Windows production box (scripts/sdk-spike.ts probe 5).",
    });

    this.subscribeToEvents();
  }

  /**
   * Tear down. Unsubscribes from session events, clears any active
   * auto-promote timer, and (best-effort) calls session.close()/shutdown().
   * Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {
        /* ignore */
      }
      this.unsubscribe = null;
    }
    this.clearAutoPromote();
    this.clearWatchdog();
    if (this.session) {
      try {
        const close = (this.session as Record<string, unknown>).close;
        if (typeof close === "function") {
          await (close as () => Promise<void>).call(this.session);
        }
      } catch {
        /* ignore */
      }
      this.session = null;
    }
    this.sdk = null;
  }

  /**
   * Route an inbound user message into the agent.
   *
   * Serialization:
   *   - Every call goes through `globalQueue.run('global', ...)` so two
   *     concurrent `handleInbound` invocations cannot drive the GPU in
   *     parallel. This mirrors gemini-claw's per-chat queue collapsed to a
   *     single key (we have ONE GPU; inference must be globally serial).
   *
   * State machine:
   *   - Refuses with no-op if a task is already in `running`/`backgrounded`
   *     state. The daemon (or channel layer) is responsible for surfacing
   *     "busy" UX; SessionManager does not double-emit.
   *   - On accept: idle → running, schedule auto-promote, hand the message
   *     to `session.prompt(text)`. We do NOT await the prompt's full
   *     resolution inside the queue lock — pi-mono streams events via
   *     subscribe() and the queue would hold the GPU lock indefinitely.
   *     Instead we await `session.prompt()` settlement (which pi-mono
   *     resolves when the agent loop ends).
   */
  async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.session) {
      throw new Error("SessionManager.handleInbound called before init()");
    }

    await this.globalQueue.run("global", async () => {
      const current = this.opts.taskState.get();
      if (current.kind === "running" || current.kind === "backgrounded") {
        // Plan v2 IMPL-D Step D.5 (UX W1 + Adversarial B4): tell the user
        // their follow-up was eaten.  The §5.1 production symptom was that
        // multi-message follow-ups silently disappeared; users had no way
        // to know whether the message was queued, dropped, or just ignored.
        // Now we emit a single `system_notice` to the originating channel
        // BEFORE the silent return so the user knows to re-send when the
        // current task finishes.
        const notice: ChannelEvent = {
          type: "system_notice",
          level: "info",
          text: "pi: still working on the previous request — your follow-up arrived but is being dropped (single in-flight task). Re-send when this one finishes.",
          ts: this.now(),
        };
        const noticeBag: Record<string, Sink | undefined> = {};
        const target = this.sinkFor(msg.channel);
        if (target) noticeBag[msg.channel] = target;
        void fanOut(noticeBag as SinkBag, notice).catch(() => undefined);

        // Drop. Plan §"Architectural revision (Option C)": single in-flight
        // task; channels surface "busy" UX upstream of SessionManager.
        void this.opts.auditLog
          .append({
            event: "serial_queue_blocked",
            task_id: current.taskId,
            channel: msg.channel,
            sender_id_hash: null,
          })
          .catch(() => undefined);
        return;
      }

      const taskId = freshTaskId();
      const startedAt = this.now();
      const transitionResult = this.opts.taskState.tryTransition({
        kind: "running",
        taskId,
        startedAt,
        channel: msg.channel,
        userMessage: msg.text,
        abort: new AbortController(),
      });
      if (!transitionResult.ok) {
        // Race lost; another caller advanced state. Drop without side-effects.
        return;
      }

      this.opts.operatorLogger?.info("task_started", {
        task_id: taskId,
        channel: msg.channel,
      });
      // Audit append is best-effort and runs in parallel with the agent loop;
      // we do NOT await it, otherwise mkdir/appendFile latency would block the
      // critical path of getting the prompt to pi-mono.
      void this.opts.auditLog
        .append({
          event: "task_started",
          task_id: taskId,
          channel: msg.channel,
          sender_id_hash: null,
        })
        .catch(() => undefined);

      this.scheduleAutoPromote(taskId);
      this.scheduleWatchdog(taskId);

      // Plan v2 IMPL-D Step D.7 (Round 1+2 elder convergence): fire-and-
      // forget soft Studio model-swap probe.  No await — the probe runs
      // in parallel with the prompt and emits a one-shot system_notice if
      // Studio's loaded model has drifted from the boot-captured one.
      // Hardening (multi-load semantics, post-abort gate, per-channel
      // cooldown, audit-log entry, studio-empty distinct alarm) lives in
      // checkForStudioModelSwap.
      void this.checkForStudioModelSwap(msg.channel);

      try {
        // Hand the message to pi-mono.  We pass the running TaskState's
        // AbortController.signal so /cancel can actually stop the GPU —
        // pi-mono ≥0.72 honors `options.signal` to cancel the inference
        // loop and tool execution.  Without this, the SDK's own
        // AbortController is internal and unreachable from /cancel.
        // Errors are caught and logged but do NOT bubble out — the daemon
        // would otherwise crash on a single bad turn.  The TaskState
        // machine drives recovery instead.
        if (this.session) {
          // Re-read the current TaskState — by this point we have just
          // CAS'd to running so the abort controller is the one we just
          // installed; this also defends against tests that manipulate
          // state out-of-band.
          const live = this.opts.taskState.get();
          const signal =
            (live.kind === "running" || live.kind === "backgrounded")
              ? live.abort.signal
              : undefined;
          await this.session.prompt(msg.text, { signal });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.opts.operatorLogger?.error("task_failed", {
          task_id: taskId,
          error,
        });
        const cur = this.opts.taskState.get();
        if (cur.kind === "running" || cur.kind === "backgrounded") {
          const finishedAt = this.now();
          this.opts.taskState.tryTransition({
            kind: "failed",
            taskId,
            startedAt,
            finishedAt,
            error,
          });
          // Audit the failure with duration_ms so post-incident review can
          // correlate task latency with the failure surface.
          void this.opts.auditLog
            .append({
              event: "task_failed",
              task_id: taskId,
              channel: msg.channel,
              sender_id_hash: null,
              duration_ms: Math.max(0, finishedAt - startedAt),
              error_class: error.slice(0, 200),
            })
            .catch(() => undefined);
        }
      } finally {
        this.clearAutoPromote();
        this.clearWatchdog();
        // SandboxPolicy lifecycle: if a `next-task` un-sand grant was open,
        // re-engage now (per plan §"v4.1 /unsand escape hatch" line 1387).
        // Window-scoped grants outlive task boundaries by design.
        try {
          this.opts.sandboxPolicy.onTaskCompleted();
        } catch {
          /* sandbox bookkeeping is best-effort */
        }
      }
    });
  }

  // ---------------------------------------------------------------------
  // Private — auto-promote
  // ---------------------------------------------------------------------

  /**
   * Schedule the FIRST auto-promote fire at config.piCommsAutoPromoteMs
   * (typically 30s).  Subsequent re-arms happen inside `fireAutoPromote`
   * via `scheduleNextAutoPromote(taskId)` — see plan v4.1 message catalog
   * (first fire 30s, second fire 2min, then every 5min capped).
   */
  private scheduleAutoPromote(taskId: string): void {
    this.clearAutoPromote();
    this.autoPromoteFiringNumber = 0;
    this.autoPromoteColdRetries = 0;
    this.autoPromoteTaskId = taskId;
    const delay = this.opts.config.piCommsAutoPromoteMs;
    this.autoPromoteHandle = this.setTimeoutFn(() => {
      void this.fireAutoPromote(taskId);
    }, delay);
  }

  /**
   * After a successful fire, schedule the NEXT one based on
   * `autoPromoteFiringNumber`.  Per plan v4.1:
   *   - After fire 1 (now firingNumber=1): next at +90s = total 2min from start
   *   - After fire 2 (now firingNumber=2): next at +5min
   *   - After fire 3+ (firingNumber>=3): next at +5min (cap)
   */
  private scheduleNextAutoPromote(taskId: string): void {
    if (this.autoPromoteHandle !== null) {
      // Defensive — shouldn't be set; clear before scheduling.
      try {
        this.clearTimeoutFn(this.autoPromoteHandle);
      } catch {
        /* ignore */
      }
      this.autoPromoteHandle = null;
    }
    const idx = Math.min(
      this.autoPromoteFiringNumber - 1,
      AUTO_PROMOTE_RE_ARM_DELAYS_MS.length - 1,
    );
    const delay =
      idx >= 0
        ? AUTO_PROMOTE_RE_ARM_DELAYS_MS[idx]
        : this.opts.config.piCommsAutoPromoteMs;
    this.autoPromoteHandle = this.setTimeoutFn(() => {
      void this.fireAutoPromote(taskId);
    }, delay);
  }

  /**
   * Reschedule the auto-promote at +coldStartRetryMs (default 30s) when
   * Studio reported the model is not loaded.  Per Pitfall #20.
   */
  private scheduleColdStartRetry(taskId: string): void {
    if (this.autoPromoteHandle !== null) {
      try {
        this.clearTimeoutFn(this.autoPromoteHandle);
      } catch {
        /* ignore */
      }
      this.autoPromoteHandle = null;
    }
    const delay = this.opts.coldStartRetryMs ?? 30_000;
    this.autoPromoteHandle = this.setTimeoutFn(() => {
      void this.fireAutoPromote(taskId);
    }, delay);
  }

  private clearAutoPromote(): void {
    if (this.autoPromoteHandle !== null) {
      try {
        this.clearTimeoutFn(this.autoPromoteHandle);
      } catch {
        /* ignore */
      }
      this.autoPromoteHandle = null;
    }
    this.autoPromoteTaskId = null;
    this.autoPromoteFiringNumber = 0;
    this.autoPromoteColdRetries = 0;
  }

  // ---------------------------------------------------------------------
  // Private — TaskState watchdog (plan v2 IMPL-D Step D.4)
  // ---------------------------------------------------------------------

  /**
   * Schedule the watchdog timer for the in-flight task.  On expiry, if the
   * task is STILL running/backgrounded, force-transition to `failed` with
   * reason `watchdog_no_terminal_event`, emit a `system_notice` to the
   * originating channel, and append an audit entry.
   *
   * Defense-in-depth (Round 2 Architect+Adversarial): the null-mapper
   * symmetry fix (Step D.3) closes the empty-text-message_end hole; this
   * watchdog catches the deeper hole where pi-mono itself stops emitting
   * any terminal event (network stall, SDK throw, compaction wedge,
   * Studio sub-process death).
   */
  private scheduleWatchdog(taskId: string): void {
    this.clearWatchdog();
    this.watchdogTaskId = taskId;
    const delay = this.opts.taskWatchdogMs ?? 300_000;
    this.watchdogHandle = this.setTimeoutFn(() => {
      void this.fireWatchdog(taskId);
    }, delay);
  }

  private clearWatchdog(): void {
    if (this.watchdogHandle !== null) {
      try {
        this.clearTimeoutFn(this.watchdogHandle);
      } catch {
        /* ignore */
      }
      this.watchdogHandle = null;
    }
    this.watchdogTaskId = null;
  }

  /**
   * Watchdog handler.  CAS-guarded: drops if the schedule has been cleared
   * (e.g. task already completed) — even if the captured handler still
   * fires (fake-timer tests, externally-held references).
   */
  private async fireWatchdog(taskId: string): Promise<void> {
    this.watchdogHandle = null;
    if (this.watchdogTaskId !== taskId) {
      return;
    }
    const state = this.opts.taskState.get();
    if (state.kind !== "running" && state.kind !== "backgrounded") {
      return;
    }
    if (state.taskId !== taskId) {
      // Defense-in-depth: this branch indicates a wedged schedule (a watchdog
      // for an old task fired after a new task started without the previous
      // task's watchdog being cleared).  If it ever fires, post-incident
      // review needs the signal to correlate.
      this.opts.operatorLogger?.debug("watchdog_drop_taskid_mismatch", {
        expected: taskId,
        current: state.taskId,
      });
      return;
    }
    const finishedAt = this.now();
    const reason = "watchdog_no_terminal_event";
    const transitionResult = this.opts.taskState.tryTransition({
      kind: "failed",
      taskId,
      startedAt: state.startedAt,
      finishedAt,
      error: reason,
    });
    if (!transitionResult.ok) {
      return;
    }
    this.clearAutoPromote();
    this.watchdogTaskId = null;

    this.opts.operatorLogger?.error("task_watchdog_fired", {
      task_id: taskId,
      reason,
    });

    const sink = this.sinkFor(state.channel);
    if (sink) {
      const notice: ChannelEvent = {
        type: "system_notice",
        text: "pi: previous task didn't emit a terminal event within the watchdog window — force-completing so new requests can run.",
        level: "warn",
        ts: finishedAt,
      };
      void sink.send(notice).catch(() => undefined);
    }

    void this.opts.auditLog
      .append({
        event: "task_failed",
        task_id: taskId,
        channel: state.channel,
        sender_id_hash: null,
        duration_ms: Math.max(0, finishedAt - state.startedAt),
        error_class: reason,
        extra: { reason },
      })
      .catch(() => undefined);

    // SandboxPolicy bookkeeping — same path as a normal completion.
    try {
      this.opts.sandboxPolicy.onTaskCompleted();
    } catch {
      /* sandbox bookkeeping is best-effort */
    }
  }

  // ---------------------------------------------------------------------
  // Private — soft Studio model-swap detector (plan v2 IMPL-D Step D.7)
  // ---------------------------------------------------------------------

  /**
   * Soft model-swap detection: re-probe Studio's loaded model and, if it
   * differs from the boot-captured `coldStartModelId` AND we haven't already
   * told the user about THIS swap AND the channel isn't in cooldown, emit a
   * one-shot `system_notice`.
   *
   * Hardening (Round 1+2 Elder findings):
   *   - Multi-load semantics: use `loaded.includes(expected)`, not
   *     `loaded[0] === expected` (Architect B1 + Adversarial B3.2 + PE W8 +
   *     Integration W5).  Studio supports multiple loaded models; as long
   *     as the boot model is still in the loaded set, the daemon's session
   *     is fine — no notice.
   *   - Studio-empty distinct alarm (PE W1): if `loaded.length === 0`, emit
   *     a different "Studio has no model loaded" notice — semantically
   *     distinct from a swap.
   *   - Per-channel cooldown (Observability W5): 60s minimum between
   *     notices per channel, regardless of model-id; prevents spam under
   *     A→B→C→B oscillation.
   *   - Post-abort gate (PE Skeptic W3): re-check `taskState.kind !==
   *     "cancelled"` before fanOut; respects the existing post-abort
   *     silence contract (the probe is fire-and-forget and may resolve
   *     after a /cancel).
   *   - Audit log entry (PE W4 + Security W4 + Obs W1): emit
   *     `studio_model_swap_detected` to the audit log alongside the
   *     operator log so the forensic trail survives operator-log rotation.
   *   - One-shot suppression via `lastSwapNoticeModelId`: once we've told
   *     the user about a swap to model B, don't repeat for B until the
   *     model changes again.
   *
   * Best-effort; never throws; fire-and-forget from handleInbound.
   */
  private async checkForStudioModelSwap(channel: ChannelId): Promise<void> {
    const probe = this.opts.getStudioLoadedModelIds;
    const expected = this.opts.coldStartModelId;
    if (!probe || !expected) return;

    let loaded: readonly string[] | null;
    try {
      loaded = await probe();
    } catch {
      // Probe failure — never raise to the caller; the daemon stays up.
      return;
    }
    if (loaded === null) return;

    // Studio reported zero loaded models — distinct alarm.
    if (loaded.length === 0) {
      // Post-abort gate also applies to the empty-studio alarm.
      if (this.opts.taskState.get().kind === "cancelled") return;
      await this.emitStudioNotice(
        channel,
        "warn",
        "pi: Studio has no model loaded — daemon cannot serve requests until you load one.",
      );
      return;
    }

    // Multi-load semantics: as long as the boot-captured model is among
    // the loaded set, no swap. Notice fires only when the cold-start model
    // is GONE.
    if (loaded.includes(expected)) return;

    const current = loaded[0]!;
    if (current === this.lastSwapNoticeModelId) return;

    // Per-channel cooldown.
    const lastAt = this.lastSwapNoticeAt.get(channel) ?? 0;
    if (this.now() - lastAt < 60_000) {
      this.opts.operatorLogger?.debug("studio_model_swap_suppressed", {
        reason: "channel_cooldown",
        current_model_id: current,
        channel,
      });
      return;
    }

    // Post-abort gate.
    if (this.opts.taskState.get().kind === "cancelled") return;

    // BLESS Adversarial NEW-2 + AUDIT-D IMPORTANT 3 — set state
    // SYNCHRONOUSLY before the await, with rollback on throw.
    //
    // Why before-await beats after-await: two concurrent probes (e.g. from
    // two parallel inbounds on the same channel) would both pass the
    // `current === lastSwapNoticeModelId` and `cooldown` checks above,
    // both reach the await with empty state, and both emit — user sees a
    // double notice.  Setting state pre-await closes that race because
    // the second probe sees `current === lastSwapNoticeModelId` on its
    // own one-shot check and bails.
    //
    // Why rollback: AUDIT-D IMPORTANT 3 wanted "don't burn the cooldown
    // for a notice that never landed".  In the realistic case fanOut
    // swallows throws (Promise.allSettled), so this catch never runs —
    // but if a future refactor of emitStudioNotice ever does throw
    // synchronously, we still want the next inbound to retry the notice.
    const previousNoticeModel = this.lastSwapNoticeModelId;
    const previousNoticeAt = this.lastSwapNoticeAt.get(channel);
    this.lastSwapNoticeModelId = current;
    this.lastSwapNoticeAt.set(channel, this.now());
    try {
      await this.emitStudioNotice(
        channel,
        "warn",
        `pi: Studio's loaded model changed since boot (was ${expected}, now ${current}). Daemon is still using ${expected} until next restart.`,
      );
    } catch {
      // Roll back so a future inbound retries the notice.  fanOut already
      // swallows throws via Promise.allSettled so this catch is defensive
      // — but the rollback preserves the AUDIT-D IMPORTANT 3 contract.
      this.lastSwapNoticeModelId = previousNoticeModel;
      if (previousNoticeAt !== undefined) {
        this.lastSwapNoticeAt.set(channel, previousNoticeAt);
      } else {
        this.lastSwapNoticeAt.delete(channel);
      }
    }

    // Operator log.  OperatorLogger has no .warn — use .info for the
    // swap-detected event (the warning level is already reflected in the
    // user-facing system_notice + the audit-log row).
    this.opts.operatorLogger?.info("studio_model_swap_detected", {
      cold_start_model_id: expected,
      current_model_id: current,
      channel,
    });
    void this.opts.auditLog
      .append({
        event: "studio_model_swap_detected",
        task_id: null,
        channel,
        sender_id_hash: null,
        extra: { cold_start_model_id: expected, current_model_id: current },
      })
      .catch(() => undefined);
  }

  /**
   * Fan-out helper for Studio-related system notices.  Emits to the
   * originating channel + mirrors to the terminal sink (when origin is
   * non-terminal) so an operator watching the terminal sees the same
   * thing the user gets on Telegram/WhatsApp.
   */
  private async emitStudioNotice(
    channel: ChannelId,
    level: "info" | "warn" | "error",
    text: string,
  ): Promise<void> {
    const notice: ChannelEvent = {
      type: "system_notice",
      level,
      text,
      ts: this.now(),
    };
    const sinkBag: Record<string, Sink | undefined> = {};
    const target = this.opts.sinks[channel as "telegram" | "whatsapp" | "terminal"];
    if (target) sinkBag[channel] = target;
    if (this.opts.sinks.terminal && channel !== "terminal") {
      sinkBag.terminal = this.opts.sinks.terminal;
    }
    await fanOut(sinkBag as SinkBag, notice).catch(() => undefined);
  }

  /**
   * Fire the auto-promote: if the state is STILL `running` for our taskId,
   * transition to `backgrounded` (CAS guard handled by TaskStateManager) and
   * emit `auto_promote_notice` to the originating channel sink.  After a
   * successful fire, RE-ARM via `scheduleNextAutoPromote` so the user sees
   * follow-up "still working" pings per plan v4.1 message catalog.
   *
   * Cold-start suppression (Pitfall #20): before firing, optionally probe
   * Studio for model-loaded.  If not loaded AND we have retries left,
   * emit a `system_notice` "warming up" event and reschedule for +30s
   * instead of firing the auto-promote.  After `coldStartMaxRetries`
   * exhausted, fire normally to avoid leaving the user without any signal.
   *
   * If the state has advanced (completed, cancelled, backgrounded by
   * go_background, etc.) we silently drop — this is the v4 fix for the
   * auto-promote race.
   */
  private async fireAutoPromote(taskId: string): Promise<void> {
    this.autoPromoteHandle = null;
    // CAS guard: the schedule has been cleared (e.g. task completed,
    // disposed) — drop without side effects even if the captured
    // handler still fires.  This catches the case where the timer
    // function was captured by an external observer (tests, fake
    // timers) and invoked AFTER `clearAutoPromote()` ran.
    if (this.autoPromoteTaskId !== taskId) {
      return;
    }
    const state = this.opts.taskState.get();
    if (
      state.kind !== "running" &&
      !(
        state.kind === "backgrounded" &&
        state.taskId === taskId &&
        this.autoPromoteFiringNumber > 0
      )
    ) {
      // Race won by another transition (or first fire and state isn't
      // running for our taskId). Suppress.
      return;
    }
    if (state.kind === "running" && state.taskId !== taskId) {
      return;
    }

    // Cold-start suppression: only relevant for the FIRST fire (the
    // model-loaded check after backgrounding is redundant because the
    // model has already produced output by that point).
    if (
      this.autoPromoteFiringNumber === 0 &&
      this.opts.isStudioModelLoaded &&
      this.autoPromoteColdRetries < (this.opts.coldStartMaxRetries ?? 5)
    ) {
      let modelReady = true;
      try {
        modelReady = await this.opts.isStudioModelLoaded();
      } catch {
        // Probe failure — fall through and fire normally.  We'd rather
        // emit a (possibly premature) "still on it" than wedge.
        modelReady = true;
      }
      if (!modelReady) {
        this.autoPromoteColdRetries += 1;
        const sink = this.sinkFor(state.channel);
        if (sink) {
          const warmingEvent: ChannelEvent = {
            type: "system_notice",
            text: "pi: warming up model, will resume shortly",
            level: "info",
            ts: this.now(),
          };
          void sink.send(warmingEvent).catch(() => undefined);
        }
        this.scheduleColdStartRetry(taskId);
        return;
      }
    }

    const promotedAt = this.now();

    // First fire transitions running → backgrounded.  Subsequent fires
    // do NOT re-transition — the task is already backgrounded; we just
    // emit another "still working" notice.
    if (this.autoPromoteFiringNumber === 0 && state.kind === "running") {
      const transitionResult = this.opts.taskState.tryTransition({
        kind: "backgrounded",
        taskId: state.taskId,
        startedAt: state.startedAt,
        channel: state.channel,
        userMessage: state.userMessage,
        abort: state.abort,
        promotedAt,
        promotedBy: "auto",
      });
      if (!transitionResult.ok) {
        return;
      }
    }

    this.autoPromoteFiringNumber += 1;
    const firingNumber = this.autoPromoteFiringNumber;

    void this.opts.auditLog
      .append({
        event: "auto_promote_fired",
        task_id: taskId,
        channel: state.channel,
        sender_id_hash: null,
        extra: {
          promoted_by: "auto",
          firing_number: firingNumber,
          // task_age_ms is exposed as scalar `extra` (not the top-level
          // duration_ms field, which is reserved for terminal-state spans).
          task_age_ms: Math.max(0, promotedAt - state.startedAt),
        },
      })
      .catch(() => undefined);
    this.opts.operatorLogger?.info("auto_promote_fired", {
      task_id: taskId,
      firing_number: firingNumber,
    });

    const ageSeconds = Math.max(
      0,
      Math.floor((promotedAt - state.startedAt) / 1000),
    );
    const event: ChannelEvent = {
      type: "auto_promote_notice",
      firingNumber,
      taskAgeSeconds: ageSeconds,
      ts: promotedAt,
    };
    const sink = this.sinkFor(state.channel);
    if (sink) {
      void sink.send(event).catch(() => undefined);
    }

    // Re-arm for the next fire.  The state is now `backgrounded`; the
    // re-arm timer's CAS guard re-checks at fire time.
    this.scheduleNextAutoPromote(taskId);
  }

  // ---------------------------------------------------------------------
  // Private — event subscription
  // ---------------------------------------------------------------------

  /**
   * Subscribe to pi-mono session events. Each event is mapped to our
   * `ChannelEvent` shape; relevant events are fanned out to channel sinks.
   *
   * Per plan §"v4.2 Decision tree" post-abort row: we DO NOT trust pi-mono
   * to stop firing events after `abort()`. The mapper itself is silent (no
   * channel-relevant events for cancelled state), AND the gate below is the
   * second line of defense: if TaskState.kind === 'cancelled', drop every
   * event regardless of mapped shape.
   */
  private subscribeToEvents(): void {
    if (!this.session) return;
    this.unsubscribe = this.session.subscribe((rawEvent) => {
      // Operator log: every event kind is debug-logged so operators can see
      // the full firehose during diagnostic sessions.
      const evt = rawEvent as Record<string, unknown> | null;
      const kind =
        evt && typeof evt === "object" && typeof evt.type === "string"
          ? (evt.type as string)
          : "<unknown>";

      if (this.opts.operatorLogger?.includeContent) {
        this.opts.operatorLogger.debug("pi_event", { kind });
      }

      // Heartbeat-touch: pi-mono is alive if it just emitted any of the
      // turn-driving events.  This is the `pi-ping` source for the dead-man
      // switch (PE Skeptic R2 #2 + plan §"Heartbeat liveness from
      // message-loop").  Best-effort — never let a heartbeat hiccup break
      // the event stream.
      if (
        kind === "message_start" ||
        kind === "message_end" ||
        kind === "tool_execution_start" ||
        kind === "agent_start"
      ) {
        try {
          this.opts.onPiActivity?.();
        } catch {
          /* heartbeat is best-effort */
        }
      }

      // Cross-cutting safety gate: post-abort silence.
      const stateKind = this.opts.taskState.get().kind;
      if (stateKind === "cancelled") {
        return;
      }

      // Adapt OperatorLogger.debug (Record<string, LogValue>) to the mapper's
      // looser Record<string, unknown> shape — the mapper field set is small
      // and known-scalar (text_length: number, redaction_applied: boolean,
      // reason: string) so widening to LogValue at the boundary is safe.
      const opLogger = this.opts.operatorLogger;
      const mapperLogger = opLogger
        ? {
            debug: (msg: string, fields?: Record<string, unknown>) => {
              opLogger.debug(
                msg,
                fields as Record<string, string | number | boolean> | undefined,
              );
            },
          }
        : undefined;
      const channelEvent = mapAgentEventToChannelEvent(rawEvent, {
        now: this.now,
        logger: mapperLogger,
      });
      if (!channelEvent) {
        // Symmetric terminal-event handling (Round 2 Architect+Adversarial
        // convergence): both `agent_end` AND `message_end` are terminal
        // markers from pi-mono's perspective.  Handling `message_end` here
        // (in addition to `agent_end`) closes the empty-text stuck-task
        // hole that was the §5.1 production symptom — when the assistant
        // message has no text content the mapper returns null, and without
        // this branch the task would stay `running` forever.
        const evt = rawEvent as Record<string, unknown> | null;
        if (evt && (evt.type === "agent_end" || evt.type === "message_end")) {
          this.markTaskCompleted();
        }
        return;
      }

      // Fan out to ALL configured sinks. This is the "framework auto-
      // completion" path per plan §"Architectural revision (Option C)".
      const sinkBag: Record<string, Sink | undefined> = {};
      if (this.opts.sinks.terminal) sinkBag.terminal = this.opts.sinks.terminal;
      if (this.opts.sinks.whatsapp) sinkBag.whatsapp = this.opts.sinks.whatsapp;
      if (this.opts.sinks.telegram) sinkBag.telegram = this.opts.sinks.telegram;
      void fanOut(sinkBag as SinkBag, channelEvent).catch(() => undefined);

      // Belt-and-suspenders: when reply landed AND no agent_end fires (some
      // pi-mono builds emit message_end as the only terminal event), still
      // mark complete.  Idempotent vs the null-mapper branch above thanks
      // to markTaskCompleted's CAS guard inside taskState.tryTransition.
      if (channelEvent.type === "reply") {
        this.markTaskCompleted();
      }
    });
  }

  /**
   * Mark the in-flight task as completed (idempotent w.r.t. terminal states).
   *
   * Called from event-stream side effects:
   *   - `agent_end` event (pi-mono full-loop completion).
   *   - `message_end` event with NO mapped channel event (empty-text turn —
   *     the plan v2 IMPL-D Round 2 convergence on the null-mapper symmetry
   *     hole that was the §5.1 production stuck-task symptom).
   *   - Mapped `reply` ChannelEvent (some pi-mono builds emit message_end as
   *     the only terminal event; the belt-and-suspenders mirror).
   *
   * The task-state CAS guard (in taskState.tryTransition) makes this safe to
   * call multiple times for the same task — only the first call wins.
   */
  private markTaskCompleted(): void {
    const state = this.opts.taskState.get();
    if (state.kind !== "running" && state.kind !== "backgrounded") {
      return;
    }
    const finishedAt = this.now();
    // BLESS Adversarial NEW-3: gate ALL side effects on tryTransition's
    // `ok` field.  pi-mono can emit multiple `message_end` events per
    // turn during streaming (and the subscriber loop also fires this from
    // the `reply` ChannelEvent mirror); without this gate, audit row +
    // operator log + sandboxPolicy.onTaskCompleted would double-fire.
    // Mirrors the pattern fireWatchdog uses correctly at L763-765.
    const transitionResult = this.opts.taskState.tryTransition({
      kind: "completed",
      taskId: state.taskId,
      startedAt: state.startedAt,
      finishedAt,
    });
    if (!transitionResult.ok) {
      return; // Already in terminal state; another path won the race.
    }
    this.clearAutoPromote();
    this.clearWatchdog();
    // Emit task_completed with duration_ms so post-incident review can
    // correlate task latency with downstream events.
    void this.opts.auditLog
      .append({
        event: "task_completed",
        task_id: state.taskId,
        channel: state.channel,
        sender_id_hash: null,
        duration_ms: Math.max(0, finishedAt - state.startedAt),
      })
      .catch(() => undefined);
    this.opts.operatorLogger?.info("task_completed", {
      task_id: state.taskId,
    });
    // SandboxPolicy lifecycle hook: re-engage on next-task scope.
    try {
      this.opts.sandboxPolicy.onTaskCompleted();
    } catch {
      /* sandbox bookkeeping is best-effort */
    }
  }

  // ---------------------------------------------------------------------
  // Private — custom-tools assembly
  // ---------------------------------------------------------------------

  /**
   * Construct the four custom tools (sandboxed-bash, tell, confirm,
   * go_background) wired to the real W1+W2 dependencies.
   *
   * Adapter for `confirm.ts`: IMPL-7's `PendingConfirmsRegistry`
   * (src/tools/pending-confirms.ts) returns `{ id, promise }` from
   * `create()`, while IMPL-8's `confirm.ts` expects
   * `{ shortId, expiresAt, promise: Promise<PendingConfirmResolution> }`
   * with `maxPerTask` + `countForTask`. We wrap the registry into a
   * structurally-compatible adapter so both can compile against their
   * declared contracts without rewriting either.
   */
  private buildCustomTools(sdk: SdkLoaded): unknown[] {
    const sinkMap: Record<string, Sink | undefined> = {};
    if (this.opts.sinks.terminal) sinkMap.terminal = this.opts.sinks.terminal;
    if (this.opts.sinks.whatsapp) sinkMap.whatsapp = this.opts.sinks.whatsapp;
    if (this.opts.sinks.telegram) sinkMap.telegram = this.opts.sinks.telegram;
    const sinks = sinkMap as SinkBag;

    // confirm.ts needs a registry whose .create() returns
    // { shortId, expiresAt, promise: Promise<{decision: 'yes'|'no'|'timeout'}> }.
    // pending-confirms.ts returns { id, promise: Promise<boolean> } where
    // false means no-or-timeout. The adapter:
    //   - exposes maxPerTask=3 (per plan §"v4.2 confirm() semantics")
    //   - countForTask via list(taskId).length
    //   - bridges the boolean→PendingConfirmResolution. Because the boolean
    //     loses the no-vs-timeout distinction, we resolve to 'no' for false;
    //     this is conservative (the agent sees "user declined" either way,
    //     which is the safe default per plan §"Pitfall #25" default-deny).
    const realRegistry = this.opts.pendingConfirms;
    this.confirmRegistryAdapter = {
      maxPerTask: 3,
      countForTask: (taskId: string) => realRegistry.list(taskId).length,
      create: (createOpts) => {
        const { id, promise } = realRegistry.create({
          taskId: createOpts.taskId,
          question: createOpts.question,
          rationale: createOpts.rationale,
          risk: createOpts.risk,
          channel:
            createOpts.channel === "system" ? "terminal" : createOpts.channel,
          ttlMs: createOpts.ttlMs,
        });
        // Look up expiresAt from the registry snapshot (we just created it,
        // so it's the entry with our id — find it by id).
        const entry = realRegistry
          .list()
          .find((e) => e.shortId === id);
        const expiresAt = entry?.expiresAt ?? this.now() + 30 * 60 * 1000;
        // AUDIT-C #10: distinguish timeout-via-expire() from user-no.  The
        // registry tags expired ids in `recentlyTimedOut`; we read+consume
        // the tag on the resolution side so the agent sees a real
        // `decision: 'timeout'` instead of always collapsing to `'no'`.
        const resolutionPromise = promise.then((approved) => {
          if (approved) return { decision: "yes" as const };
          if (realRegistry.consumeTimedOut(id)) {
            return { decision: "timeout" as const };
          }
          return { decision: "no" as const };
        });
        return { shortId: id, expiresAt, promise: resolutionPromise };
      },
    };

    const bashTool = defineSandboxedBashTool({
      sandboxPolicy: this.opts.sandboxPolicy,
      classifier: { classify },
      workspace: this.opts.config.piCommsWorkspace,
      confirmTool: undefined,
      // The wrapper invokes confirm via this hook. Bridges classifier
      // verdicts into a confirm() flow without passing the confirmTool
      // directly to the bash wrapper (per IMPL-9 separation of concerns).
      invokeConfirm: async (req) => {
        const taskId = this.currentTaskId();
        if (!taskId) {
          return { approved: false, reason: "rejected" };
        }
        if (this.confirmRegistryAdapter!.countForTask(taskId) >=
          this.confirmRegistryAdapter!.maxPerTask) {
          return { approved: false, reason: "capped" };
        }
        const handle = this.confirmRegistryAdapter!.create({
          taskId,
          question: req.cmd,
          rationale: req.rationale,
          risk: req.risk,
          channel: this.currentChannel() ?? "terminal",
        });
        const resolution = await handle.promise;
        if (resolution.decision === "yes") return { approved: true };
        if (resolution.decision === "timeout") {
          return { approved: false, reason: "timed_out" };
        }
        return { approved: false, reason: "rejected" };
      },
      defineTool: sdk.defineTool,
      audit: {
        classifierBlock: (cmd, reason, severity) => {
          void this.opts.auditLog
            .append({
              event: "classifier_block",
              task_id: this.currentTaskId(),
              channel: this.currentChannel() ?? "system",
              sender_id_hash: null,
              extra: {
                reason: reason ?? "destructive command pattern",
                severity: severity ?? "high",
              },
            })
            .catch(() => undefined);
        },
        classifierConfirmRequired: (_cmd, severity) => {
          void this.opts.auditLog
            .append({
              event: "classifier_confirm_required",
              task_id: this.currentTaskId(),
              channel: this.currentChannel() ?? "system",
              sender_id_hash: null,
              extra: { severity: severity ?? "high" },
            })
            .catch(() => undefined);
        },
      },
    });

    // We capture the DefinedTool shapes locally and pass them through
    // sdk.defineTool when pi-mono's customTools registration requires it.
    // Pi-mono's API takes raw ToolDefinition objects; wrapping our
    // structurally-compatible DefinedTool through defineTool here lets
    // pi-mono apply its own normalization (e.g. label, executionMode).
    const tellDef = defineTellTool({
      sinks,
      cooldownMap: this.tellCooldownMap,
      sanitizeOutbound: redactCredentialShapes,
      onEmit: (ts) => {
        try {
          this.opts.onTellEmit?.(ts);
        } catch {
          /* observer is best-effort */
        }
      },
    });
    const confirmDef = defineConfirmTool({
      pendingConfirms: this.confirmRegistryAdapter,
      sinks,
      getCurrentTaskId: () => this.currentTaskId(),
      sanitizeOutbound: redactCredentialShapes,
    });
    // IMPL-8's defineGoBackgroundTool declares its own structural-stub
    // TaskState type that mirrors task-state.ts's union shape. The two are
    // structurally identical at the kind/payload level, so a single cast is
    // safe (and simpler than reconstructing the type via conditional inference).
    type GoBgInput = Parameters<typeof defineGoBackgroundTool>[0];
    const goBgDef = defineGoBackgroundTool({
      taskState: {
        get: () => this.opts.taskState.get() as ReturnType<GoBgInput["taskState"]["get"]>,
        tryTransition: (args) => {
          const cur = this.opts.taskState.get();
          if (cur.kind !== "running" || cur.taskId !== args.fromTaskId) {
            return { ok: false, reason: "cas_failed" };
          }
          return this.opts.taskState.tryTransition({
            kind: "backgrounded",
            taskId: cur.taskId,
            startedAt: cur.startedAt,
            channel: cur.channel,
            userMessage: cur.userMessage,
            abort: cur.abort,
            promotedAt: args.promotedAt,
            promotedBy: args.promotedBy,
          });
        },
      },
      sinks,
    });

    return [bashTool, sdk.defineTool(tellDef), sdk.defineTool(confirmDef), sdk.defineTool(goBgDef)];
  }

  // ---------------------------------------------------------------------
  // Private — small accessors
  // ---------------------------------------------------------------------

  private sinkFor(channel: ChannelId): Sink | undefined {
    if (channel === "terminal") return this.opts.sinks.terminal;
    if (channel === "whatsapp") return this.opts.sinks.whatsapp;
    if (channel === "telegram") return this.opts.sinks.telegram;
    return undefined;
  }

  private currentTaskId(): string | null {
    const s = this.opts.taskState.get();
    if (s.kind === "running" || s.kind === "backgrounded") return s.taskId;
    return null;
  }

  private currentChannel(): ChannelId | null {
    const s = this.opts.taskState.get();
    if (s.kind === "running" || s.kind === "backgrounded") return s.channel;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshTaskId(): string {
  return `T-${randomBytes(6).toString("hex")}`;
}

function clipPreview(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Re-exports for caller convenience
// ---------------------------------------------------------------------------

export type { TaskState };
