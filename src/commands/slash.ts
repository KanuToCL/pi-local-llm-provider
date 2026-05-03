/**
 * Slash command parser + dispatcher.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"Slash command set (revised)" (line 907): the 8 v3 commands plus
 *     the v4-era additions (`/unsand`, `/alive`, `/lock`, `/unlock`,
 *     `/shutdown`).  Total: 14 commands routed from any channel
 *     (terminal, telegram, whatsapp).
 *   - §"v4.2 confirm() resolveMostRecent semantics" (lines 1133-1138):
 *     bare `/confirm yes|no` resolves the most-recent pending entry
 *     when exactly one is pending; refuses with the pending-id list
 *     when 2+ are pending; replies "no pending confirms" when zero.
 *   - §"v4.1 /unsand escape hatch" (line 1387): three forms — bare
 *     `/unsand` (next-task scope), `/unsand <minutes>` (1..120 window),
 *     `/unsand off` (re-engage immediately).  v4.1 RS-6 + v4.2 RS-6
 *     revised: first-per-session AND tool-derived `/unsand` calls require
 *     terminal-side ack.  This module gates by `ctx.isTerminal` for the
 *     first-per-session path; tool-derived flows are evaluated upstream
 *     via the `getUnsandRequiresTerminalAck()` dep callback.
 *   - §"Remote-Shell Threat Model" RS-1 (line 1179): `/alive` heartbeat
 *     bumps the dead-man clock (kept in the daemon).
 *   - §"Remote-Shell Threat Model" RS-2 (line 1180): `/lock` panic word
 *     halts further bash-tool execution from any channel; `/unlock` is
 *     terminal-only because the threat model is "stolen unlocked phone."
 *   - §"v4 — UX Advocate Round-1 LOW" (paraphrased in IMPL-14 brief):
 *     `/cancel` for tasks running >2 min requires a follow-up `/cancel
 *     yes` confirm within 30 s; short tasks cancel immediately.
 *
 * The router is channel-agnostic and stateless except for the cancel-
 * confirm timer and the ambiguous-confirm last-list (so the channel handler
 * can show pending IDs to the user).  All durable state lives in the deps
 * (TaskStateManager, PendingConfirmsRegistry, SandboxPolicy, AuditLog).
 *
 * Lifted helper: `extractCommandArgument` originates in gemini-claw
 * `src/bot/commands.ts:304-311` and supports the `/cmd@bot` form Telegram
 * appends in groups.  We keep the same regex shape and behavior so the
 * existing test fixtures map cleanly.
 */

import type { ChannelId, TaskState, TaskStateManager } from "../lib/task-state.js";
import type { PendingConfirmsRegistry } from "../tools/pending-confirms.js";
import type { SandboxPolicy } from "../sandbox/policy.js";
import type { StatusPointerReader } from "../status-pointer/reader.js";
import type { AuditLog } from "../audit/log.js";
import type { OperatorLogger } from "../utils/operator-logger.js";

/** The set of channels a command can originate from.  Mirrors `ChannelId`. */
export type { ChannelId } from "../lib/task-state.js";

/** One command invocation.  Constructed by the channel handler from the raw line. */
export interface SlashCommandContext {
  /** Full original line (e.g. "/confirm A7K9 yes"). */
  raw: string;
  senderChannel: ChannelId;
  /** Hashed or literal sender id — channel decides. */
  senderId: string;
  /**
   * True when the invocation originated at the terminal (vs phone).  Used
   * for the `/unlock` / `/shutdown` terminal-only gate AND the first-per-
   * session `/unsand` ack per v4.1 RS-6.
   */
  isTerminal: boolean;
}

/**
 * Dependencies the dispatcher needs.  Wired by the daemon at boot;
 * channel handlers each receive the same dispatcher instance.
 */
export interface SlashCommandDeps {
  taskState: TaskStateManager;
  pendingConfirms: PendingConfirmsRegistry;
  sandboxPolicy: SandboxPolicy;
  statusPointerReader: StatusPointerReader;
  auditLog: AuditLog;
  operatorLogger?: OperatorLogger;
  /** Halts further bash-tool execution per RS-2 `/lock`. */
  onPanicLock(): Promise<void>;
  /** Counterpart to onPanicLock; gated terminal-only by the dispatcher. */
  onPanicUnlock(): Promise<void>;
  /** Bumps the dead-man heartbeat per RS-1 `/alive`. */
  onAlive(): void;
  /**
   * Cancel the in-flight task.  Returns whether a task was actually
   * cancelled and (when so) its taskId for the user-visible reply.
   */
  onCancelTask(): Promise<{ cancelled: boolean; taskId?: string }>;
  /** Clears the status pointer + forces a fresh agent context. */
  onResetSession(): Promise<void>;
  /** Terminal-only.  Drains the daemon and exits cleanly. */
  onShutdownDaemon(): Promise<void>;
  /**
   * Optional: returns the `Date.now()`-style ms timestamp of the most
   * recent `tell()` emit, or null if none yet.  Surfaced by `/status`.
   * The daemon owns the source of truth (the `defineTellTool`
   * `cooldownMap` doesn't index by time-only); this callback is the
   * lift point.
   */
  getLastTellAt?(): number | null;
  /**
   * Optional: returns true when the next `/unsand` must require terminal
   * ack regardless of `isTerminal` (e.g. tool-derived flow per v4.2 RS-6).
   * Defaults to false when omitted, in which case only the first-per-
   * session `isTerminal` gate applies.
   */
  getUnsandRequiresTerminalAck?(): boolean;
  /**
   * Optional: returns true when the daemon believes this session has not
   * yet seen a terminal-side `/unsand` ack (per v4.2 §"Session boundary
   * precisely defined").  When true, the dispatcher gates `/unsand` on
   * `ctx.isTerminal`.  Defaults to true (conservative) when omitted.
   */
  isFirstUnsandPerSession?(): boolean;
}

/** Outcome of dispatch. */
export interface SlashCommandResult {
  /** True iff the input was a slash command (whether or not it succeeded). */
  handled: boolean;
  /** User-facing reply text (chunking is the channel's responsibility). */
  reply?: string;
}

/**
 * Per-instance state the dispatcher needs to remember between calls.
 * Two pieces of memory: the `/cancel` confirm-window expiry and the
 * "last `/cancel` invocation" timestamp so `/cancel yes` knows whether
 * to accept the bypass.  We keep both at module-instance scope; if a
 * second router were ever instantiated on the same deps it would be a
 * code bug, not a multi-tenant design.
 */
interface CancelConfirmState {
  /** Wall-clock ms after which the confirm-window has elapsed. */
  expiresAt: number;
  /** Original `/cancel` channel — informational, not used as a gate. */
  channel: ChannelId;
}

/** ms a `/cancel` confirm window stays open. */
const CANCEL_CONFIRM_WINDOW_MS = 30_000;

/** Threshold above which `/cancel` requires a follow-up `/cancel yes`. */
const LONG_TASK_THRESHOLD_MS = 2 * 60_000;

/**
 * Lifted from gemini-claw `src/bot/commands.ts:304-311`.  Strips the
 * leading `/cmd` (and optional `@botname` Telegram suffix) and returns
 * the remaining trimmed argument string.  Empty string when no argument
 * is present.
 *
 * Exported for the test suite — the Telegram `/cmd@bot arg` form is
 * one of the bug-classes this helper closes.
 */
export function extractCommandArgument(text: string | undefined, command: string): string {
  if (!text) return "";
  // Escape regex metacharacters in `command` defensively.  `command` is
  // hardcoded by the dispatcher today, but a future caller might pass
  // user input.
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^/${escaped}(?:@\\S+)?\\s*`, "i");
  return text.replace(pattern, "").trim();
}

/**
 * Parse the leading slash command name from `raw`.  Returns the lowercased
 * command name (without the leading `/` and without any `@botname` suffix)
 * or null when the input does not look like a slash command.
 */
function parseCommandName(raw: string): string | null {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("/")) return null;
  // Match `/cmd` then an optional `@botname` then end-of-token.
  const m = /^\/([A-Za-z_][A-Za-z0-9_]*)(?:@\S+)?(?:\s|$)/.exec(trimmed);
  if (!m || !m[1]) return null;
  return m[1].toLowerCase();
}

/**
 * Format the human-readable help message.  Lifted shape from gemini-claw
 * `formatHelpMessage` (line 172) — one command per line, no markdown
 * formatting (channels render plain text uniformly).
 */
export function formatHelpMessage(): string {
  return [
    "pi-comms commands:",
    "/start - welcome + this help.",
    "/help - show this help.",
    "/status - current task, sandbox state, last tell() time.",
    "/cancel - abort current task (long tasks need /cancel yes confirm).",
    "/cancel yes - confirm a pending /cancel for a long-running task.",
    "/reset - clear status pointer + force fresh agent context.",
    "/confirm <id> yes|no - respond to a pending destructive-command confirm.",
    "/confirm yes|no - resolve the only pending confirm (refuses if 2+).",
    "/pointer - show the current status-pointer body.",
    "/who - debug: which surface and sender id is asking.",
    "/unsand - disable sandbox for the next single task.",
    "/unsand <minutes> - disable sandbox for N minutes (1-120).",
    "/unsand off - re-engage sandbox immediately.",
    "/alive - bump the dead-man heartbeat (RS-1).",
    "/lock - halt bash-tool execution (RS-2 panic word).",
    "/unlock - resume bash-tool execution (terminal only).",
    "/shutdown - drain + exit the daemon (terminal only).",
  ].join("\n");
}

/**
 * Welcome text emitted by `/start`.  Includes the help body so first-DM
 * users see the full command list (per UX Advocate Round-1 MED).
 */
function formatStartMessage(): string {
  return ["Hi, I'm pi.  Ask me to write code or /help for commands.", "", formatHelpMessage()].join("\n");
}

/**
 * Render the in-flight task summary used by `/status`.
 */
function formatStatusMessage(
  task: TaskState,
  sandboxOn: boolean,
  lastTellAt: number | null,
): string {
  const lines: string[] = [];
  switch (task.kind) {
    case "idle":
      lines.push("task: idle");
      break;
    case "running":
      lines.push(
        `task: running (id=${task.taskId}, channel=${task.channel}, started ${secondsAgo(task.startedAt)}s ago)`,
      );
      break;
    case "backgrounded":
      lines.push(
        `task: backgrounded (id=${task.taskId}, channel=${task.channel}, started ${secondsAgo(task.startedAt)}s ago, promoted by ${task.promotedBy})`,
      );
      break;
    case "completed":
      lines.push(`task: completed (id=${task.taskId})`);
      break;
    case "cancelled":
      lines.push(`task: cancelled (id=${task.taskId}, reason=${task.reason})`);
      break;
    case "failed":
      lines.push(`task: failed (id=${task.taskId}, error=${task.error})`);
      break;
  }
  lines.push(`sandbox: ${sandboxOn ? "on" : "off"}`);
  lines.push(`last tell(): ${lastTellAt === null ? "never" : `${secondsAgo(lastTellAt)}s ago`}`);
  return lines.join("\n");
}

function secondsAgo(ts: number): number {
  return Math.max(0, Math.floor((Date.now() - ts) / 1000));
}

/**
 * The dispatcher.  One instance per daemon; channel handlers all share
 * it.  See the file-level docstring for the per-command wiring.
 */
export class SlashCommandRouter {
  private readonly deps: SlashCommandDeps;
  /** Active `/cancel` confirm window, if any. */
  private cancelConfirm: CancelConfirmState | null = null;

  constructor(deps: SlashCommandDeps) {
    this.deps = deps;
  }

  /**
   * Parse + route a single inbound line.  Returns `handled: false` when
   * `raw` is not a slash command (channel handler should treat the line
   * as a user prompt).  Returns `handled: true` (with optional `reply`)
   * for every recognized command, including unknown `/foo` (which gets
   * "Unknown command. /help for list.").
   */
  async dispatch(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const command = parseCommandName(ctx.raw);
    if (command === null) return { handled: false };
    this.logCommand(command, ctx);
    switch (command) {
      case "start":
        return { handled: true, reply: formatStartMessage() };
      case "help":
        return { handled: true, reply: formatHelpMessage() };
      case "status":
        return this.handleStatus();
      case "cancel":
        return this.handleCancel(ctx);
      case "reset":
        return this.handleReset();
      case "confirm":
        return this.handleConfirm(ctx);
      case "pointer":
        return this.handlePointer();
      case "who":
        return this.handleWho(ctx);
      case "unsand":
        return this.handleUnsand(ctx);
      case "alive":
        return this.handleAlive();
      case "lock":
        return this.handleLock();
      case "unlock":
        return this.handleUnlock(ctx);
      case "shutdown":
        return this.handleShutdown(ctx);
      default:
        return { handled: true, reply: "Unknown command.  /help for list." };
    }
  }

  // -------------------------------------------------------------------
  // Per-command handlers — kept private + small.  All user-visible text
  // is composed inline so changes are co-located with their command.
  // -------------------------------------------------------------------

  private handleStatus(): SlashCommandResult {
    const task = this.deps.taskState.get();
    const sandboxOn = this.deps.sandboxPolicy.isSandboxed();
    const lastTellAt = this.deps.getLastTellAt ? this.deps.getLastTellAt() : null;
    return { handled: true, reply: formatStatusMessage(task, sandboxOn, lastTellAt) };
  }

  private async handleCancel(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const arg = extractCommandArgument(ctx.raw, "cancel").toLowerCase();
    const task = this.deps.taskState.get();

    // `/cancel yes` follow-up — only meaningful inside the confirm window.
    if (arg === "yes") {
      if (this.cancelConfirm === null || Date.now() > this.cancelConfirm.expiresAt) {
        this.cancelConfirm = null;
        return {
          handled: true,
          reply: "no pending /cancel to confirm — issue /cancel first.",
        };
      }
      this.cancelConfirm = null;
      return this.invokeCancel();
    }

    // Bare `/cancel` — short tasks cancel immediately, long tasks open
    // the confirm window per UX Advocate Round-1 LOW.
    if (task.kind !== "running" && task.kind !== "backgrounded") {
      return { handled: true, reply: "no task in flight." };
    }
    const ageMs = Date.now() - task.startedAt;
    if (ageMs <= LONG_TASK_THRESHOLD_MS) {
      return this.invokeCancel();
    }
    this.cancelConfirm = {
      expiresAt: Date.now() + CANCEL_CONFIRM_WINDOW_MS,
      channel: ctx.senderChannel,
    };
    return {
      handled: true,
      reply: `task has been running ${Math.floor(ageMs / 1000)}s.  reply /cancel yes within 30s to confirm cancellation.`,
    };
  }

  private async invokeCancel(): Promise<SlashCommandResult> {
    const result = await this.deps.onCancelTask();
    if (!result.cancelled) {
      return { handled: true, reply: "no task in flight." };
    }
    return {
      handled: true,
      reply: `cancelled${result.taskId ? ` task ${result.taskId}` : ""}.`,
    };
  }

  private async handleReset(): Promise<SlashCommandResult> {
    await this.deps.onResetSession();
    return { handled: true, reply: "reset.  fresh session next message." };
  }

  private async handleConfirm(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const arg = extractCommandArgument(ctx.raw, "confirm");
    const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return { handled: true, reply: "usage: /confirm <id> yes|no  OR  /confirm yes|no" };
    }
    // Bare yes/no form — resolve most recent.
    if (tokens.length === 1) {
      const decision = tokens[0].toLowerCase();
      if (decision !== "yes" && decision !== "no") {
        return {
          handled: true,
          reply: "usage: /confirm <id> yes|no  OR  /confirm yes|no",
        };
      }
      const r = this.deps.pendingConfirms.resolveMostRecent(decision);
      if (r.ambiguous) {
        const ids = this.deps.pendingConfirms.list().map((c) => c.shortId);
        return {
          handled: true,
          reply: `multiple pending confirms — use /confirm <id> yes|no.  pending: ${ids.join(", ")}`,
        };
      }
      if (!r.resolved) {
        return { handled: true, reply: "no pending confirms." };
      }
      return { handled: true, reply: `confirm resolved (${decision}).` };
    }
    // <id> yes|no form.
    const id = tokens[0];
    const decision = tokens[1].toLowerCase();
    if (decision !== "yes" && decision !== "no") {
      return {
        handled: true,
        reply: "usage: /confirm <id> yes|no  OR  /confirm yes|no",
      };
    }
    const found = this.deps.pendingConfirms.resolve(id, decision);
    if (!found) {
      return {
        handled: true,
        reply: `no pending confirm with id ${id} (already resolved or expired).`,
      };
    }
    return { handled: true, reply: `confirm ${id} resolved (${decision}).` };
  }

  private async handlePointer(): Promise<SlashCommandResult> {
    const ptr = await this.deps.statusPointerReader.read();
    if (!ptr) {
      return { handled: true, reply: "status pointer is empty." };
    }
    return { handled: true, reply: ["```", ptr.raw, "```"].join("\n") };
  }

  private handleWho(ctx: SlashCommandContext): SlashCommandResult {
    return {
      handled: true,
      reply: `channel=${ctx.senderChannel}  sender=${ctx.senderId}  isTerminal=${ctx.isTerminal}`,
    };
  }

  private async handleUnsand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const arg = extractCommandArgument(ctx.raw, "unsand").trim().toLowerCase();

    // `/unsand off` — immediate re-engage.  No ack gate (re-engaging is
    // the safe direction; v4.1 doesn't require terminal ack to TIGHTEN
    // policy).
    if (arg === "off") {
      this.deps.sandboxPolicy.enable();
      return { handled: true, reply: "sandbox re-engaged." };
    }

    // Compute whether this grant requires terminal-side ack.  Two
    // independent triggers per v4.1 RS-6 + v4.2 RS-6 revised:
    //   (a) first-per-session
    //   (b) tool-derived
    // Both default conservatively (true) when the dep callback is omitted.
    const firstPerSession = this.deps.isFirstUnsandPerSession ? this.deps.isFirstUnsandPerSession() : true;
    const toolDerived = this.deps.getUnsandRequiresTerminalAck
      ? this.deps.getUnsandRequiresTerminalAck()
      : false;
    const needsAck = firstPerSession || toolDerived;
    if (needsAck && !ctx.isTerminal) {
      await this.auditAllowlistReject("unsand", ctx, needsAck && firstPerSession ? "first_per_session_no_terminal_ack" : "tool_derived_no_terminal_ack");
      return {
        handled: true,
        reply: "first-session /unsand requires terminal ack — please run from your desk first.",
      };
    }

    // Window form: `/unsand <minutes>` validated 1..120.
    if (arg !== "") {
      const minutes = parseUnsandMinutes(arg);
      if (minutes === null) {
        return {
          handled: true,
          reply: "usage: /unsand  OR  /unsand <minutes>  OR  /unsand off",
        };
      }
      if (minutes < 1) {
        return { handled: true, reply: "/unsand minutes must be at least 1." };
      }
      if (minutes > 120) {
        return {
          handled: true,
          reply: "/unsand window cap is 120 minutes (Pitfall #31).",
        };
      }
      const r = this.deps.sandboxPolicy.disable({
        scope: "window",
        windowMinutes: minutes,
        toolDerived,
        sessionAck: ctx.isTerminal,
        firstPerSession,
      });
      if (!r.ok) {
        return {
          handled: true,
          reply: `/unsand rejected: ${r.reason ?? "unknown reason"}.`,
        };
      }
      return {
        handled: true,
        reply: `sandbox disabled for ${minutes} min.  re-engages automatically at window end.`,
      };
    }

    // Default form: `/unsand` (next-task scope).
    const r = this.deps.sandboxPolicy.disable({
      scope: "next-task",
      toolDerived,
      sessionAck: ctx.isTerminal,
      firstPerSession,
    });
    if (!r.ok) {
      return {
        handled: true,
        reply: `/unsand rejected: ${r.reason ?? "unknown reason"}.`,
      };
    }
    return {
      handled: true,
      reply: "sandbox disabled for next task.  re-engages on completion.",
    };
  }

  private handleAlive(): SlashCommandResult {
    this.deps.onAlive();
    return { handled: true, reply: "alive ack — heartbeat bumped." };
  }

  private async handleLock(): Promise<SlashCommandResult> {
    await this.deps.onPanicLock();
    return {
      handled: true,
      reply: "LOCKED.  bash tool halted.  use /unlock from terminal to resume.",
    };
  }

  private async handleUnlock(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    if (!ctx.isTerminal) {
      await this.auditAllowlistReject("unlock", ctx, "not_terminal");
      return {
        handled: true,
        reply: "/unlock is terminal-only.  reply from your desk.",
      };
    }
    await this.deps.onPanicUnlock();
    return { handled: true, reply: "unlocked.  bash tool resumed." };
  }

  private async handleShutdown(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    if (!ctx.isTerminal) {
      await this.auditAllowlistReject("shutdown", ctx, "not_terminal");
      return {
        handled: true,
        reply: "/shutdown is terminal-only.  reply from your desk.",
      };
    }
    await this.deps.onShutdownDaemon();
    return { handled: true, reply: "shutting down." };
  }

  // -------------------------------------------------------------------
  // Logging / audit helpers
  // -------------------------------------------------------------------

  private logCommand(command: string, ctx: SlashCommandContext): void {
    if (!this.deps.operatorLogger) return;
    this.deps.operatorLogger.info("command", {
      command,
      channel: ctx.senderChannel,
      sender: ctx.senderId,
      terminal: ctx.isTerminal,
    });
  }

  /**
   * Emit an `allowlist_reject` audit event when a terminal-only command
   * arrives from a phone surface.  Best-effort — failures are swallowed
   * so a transient disk error never crashes the dispatcher.
   */
  private async auditAllowlistReject(
    command: string,
    ctx: SlashCommandContext,
    reason: string,
  ): Promise<void> {
    try {
      await this.deps.auditLog.append({
        event: "allowlist_reject",
        task_id: null,
        channel: ctx.senderChannel,
        sender_id_hash: ctx.senderId,
        extra: {
          command,
          reason,
          terminal: ctx.isTerminal,
        },
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * Parse `/unsand <arg>` minutes argument.  Returns the integer minute
 * count when `arg` is a positive integer literal; null otherwise.
 *
 * Floats / NaN / negative numbers / non-numeric strings all return null
 * so the caller can emit the usage hint.
 */
function parseUnsandMinutes(arg: string): number | null {
  if (!/^[0-9]+$/.test(arg)) return null;
  const n = Number(arg);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}
