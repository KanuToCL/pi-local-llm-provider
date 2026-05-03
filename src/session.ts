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

import { randomBytes } from "node:crypto";

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
  /** Path to the SHA-pinned base prompt. Defaults to `prompts/coding-agent.v1.txt`. */
  basePromptPath?: string;
  /** Optional path to the status pointer file (composed into system prompt). */
  pointerPath?: string;
  /** Pointer body cap in graphemes. Defaults to 2000 per Data Guardian. */
  pointerSizeCap?: number;
  /** Optional injectable SDK loader (for tests — substitute a mock). */
  loadSdkOverride?: () => Promise<SdkLoaded>;
  /** Optional injectable models.json loader (for tests). Returns void on
   *  successful validation; throws on failure. */
  validateModelsJsonOverride?: (path: string) => Promise<void>;
  /** Time source (ms). Defaults to Date.now. */
  now?: () => number;
  /** setTimeout function (for fake-timer tests). Defaults to global setTimeout. */
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  /** clearTimeout function (for fake-timer tests). Defaults to global clearTimeout. */
  clearTimeoutFn?: (handle: unknown) => void;
}

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
    const promptText = composeSystemPrompt({
      basePromptPath:
        this.opts.basePromptPath ?? "prompts/coding-agent.v1.txt",
      pointerPath: this.opts.pointerPath,
      pointerSizeCap: this.opts.pointerSizeCap ?? 2000,
    });
    this.opts.operatorLogger?.debug("session_recreate", {
      prompt_chars: promptText.length,
      tools: customTools.length,
    });

    const result = await this.sdk.createAgentSession({
      cwd: this.opts.config.piCommsWorkspace,
      customTools,
    });
    this.session = result.session;
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

      try {
        // Hand the message to pi-mono. Errors are caught and logged but do
        // NOT bubble out — the daemon would otherwise crash on a single
        // bad turn. The TaskState machine drives recovery instead.
        if (this.session) {
          await this.session.prompt(msg.text);
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.opts.operatorLogger?.error("task_failed", {
          task_id: taskId,
          error,
        });
        const cur = this.opts.taskState.get();
        if (cur.kind === "running" || cur.kind === "backgrounded") {
          this.opts.taskState.tryTransition({
            kind: "failed",
            taskId,
            startedAt,
            finishedAt: this.now(),
            error,
          });
        }
      } finally {
        this.clearAutoPromote();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Private — auto-promote
  // ---------------------------------------------------------------------

  private scheduleAutoPromote(taskId: string): void {
    this.clearAutoPromote();
    const delay = this.opts.config.piCommsAutoPromoteMs;
    this.autoPromoteHandle = this.setTimeoutFn(() => {
      this.fireAutoPromote(taskId);
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
  }

  /**
   * Fire the auto-promote: if the state is STILL `running` for our taskId,
   * transition to `backgrounded` (CAS guard handled by TaskStateManager) and
   * emit `auto_promote_notice` to the originating channel sink. If the state
   * has advanced (completed, cancelled, backgrounded by go_background, etc.)
   * we silently drop — this is the v4 fix for the auto-promote race.
   */
  private fireAutoPromote(taskId: string): void {
    this.autoPromoteHandle = null;
    const state = this.opts.taskState.get();
    if (state.kind !== "running" || state.taskId !== taskId) {
      // Race won by another transition. Suppress.
      return;
    }
    const promotedAt = this.now();
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

    void this.opts.auditLog
      .append({
        event: "auto_promote_fired",
        task_id: taskId,
        channel: state.channel,
        sender_id_hash: null,
        extra: { promoted_by: "auto" },
      })
      .catch(() => undefined);
    this.opts.operatorLogger?.info("auto_promote_fired", {
      task_id: taskId,
    });

    const ageSeconds = Math.max(
      0,
      Math.floor((promotedAt - state.startedAt) / 1000)
    );
    const event: ChannelEvent = {
      type: "auto_promote_notice",
      firingNumber: 1,
      taskAgeSeconds: ageSeconds,
      ts: promotedAt,
    };
    const sink = this.sinkFor(state.channel);
    if (sink) {
      void sink.send(event).catch(() => undefined);
    }
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
      if (this.opts.operatorLogger?.includeContent) {
        const evt = rawEvent as Record<string, unknown> | null;
        const kind =
          evt && typeof evt === "object" && typeof evt.type === "string"
            ? (evt.type as string)
            : "<unknown>";
        this.opts.operatorLogger.debug("pi_event", { kind });
      }

      // Cross-cutting safety gate: post-abort silence.
      const stateKind = this.opts.taskState.get().kind;
      if (stateKind === "cancelled") {
        return;
      }

      const channelEvent = mapAgentEventToChannelEvent(rawEvent, {
        now: this.now,
      });
      if (!channelEvent) {
        // Side effect: framework-completion gating. If the underlying event
        // is `agent_end`, mark the task complete in TaskState so subsequent
        // inbounds can run.
        const evt = rawEvent as Record<string, unknown> | null;
        if (evt && evt.type === "agent_end") {
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

      // After successful framework-completion fan-out, transition the task
      // to completed (if we were running/backgrounded). This is the analog
      // of the agent_end side-effect above — message_end can also be the
      // terminal event in some pi-mono builds.
      if (channelEvent.type === "tell" && channelEvent.urgency === "done") {
        this.markTaskCompleted();
      }
    });
  }

  /**
   * Mark the in-flight task as completed (idempotent w.r.t. terminal states).
   * Called from event-stream side effects (agent_end / message_end-as-tell).
   */
  private markTaskCompleted(): void {
    const state = this.opts.taskState.get();
    if (state.kind !== "running" && state.kind !== "backgrounded") {
      return;
    }
    this.opts.taskState.tryTransition({
      kind: "completed",
      taskId: state.taskId,
      startedAt: state.startedAt,
      finishedAt: this.now(),
    });
    this.clearAutoPromote();
    void this.opts.auditLog
      .append({
        event: "task_completed",
        task_id: state.taskId,
        channel: state.channel,
        sender_id_hash: null,
      })
      .catch(() => undefined);
    this.opts.operatorLogger?.info("task_completed", {
      task_id: state.taskId,
    });
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
        const resolutionPromise = promise.then((approved) => ({
          // false ≡ no-or-timeout; we collapse to 'no' because the agent's
          // safe default is "treat unanswered as declined" (plan default-deny).
          decision: approved ? ("yes" as const) : ("no" as const),
        }));
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
    });
    const confirmDef = defineConfirmTool({
      pendingConfirms: this.confirmRegistryAdapter,
      sinks,
      getCurrentTaskId: () => this.currentTaskId(),
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
