// Lifted from gemini-claw/src/utils/operatorLogger.ts (MIT, 2026-04 baseline) and
// adapted for pi-comms: extended icon registry with the pi-comms event vocabulary
// (see plan §"v4 changelog" Observability rows) and replaced the banner header
// text. Three styles (pretty/plain/json) and three levels (silent/info/debug);
// `includeContent: false` is the default — keep operator output screen-recording
// safe. Set `OPERATOR_LOG_CONTENT=true` only on machines where full prompt and
// response text is safe to display.
//
// AUDIT-A #18: when `filePath` is set the logger ALSO appends each line to
// disk, with daily rotation (`<filePath>.YYYY-MM-DD`).  This mirrors gemini-
// claw's pattern (one file per UTC day, suffix appended to the base path).
// Console output continues unchanged so operators tailing stdout still see
// the live stream.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type OperatorLogLevel = "silent" | "info" | "debug";
export type OperatorLogStyle = "pretty" | "plain" | "json";

export interface OperatorLoggerOptions {
  level: OperatorLogLevel;
  style: OperatorLogStyle;
  includeContent: boolean;
  previewChars: number;
  /**
   * Console writer.  Defaults to `console.log`.  Tests inject a buffer.
   * When `filePath` is set, lines are tee'd to the file regardless of
   * whether `write` was overridden.
   */
  write?: (line: string) => void;
  /**
   * Optional base file path for daily-rotated persistence.  When set,
   * every line is also appended to `<filePath>.YYYY-MM-DD` (mode 0600
   * on POSIX; Windows ACLs apply).  The parent directory is created if
   * absent.  File-write failures are silently dropped — the audit log
   * remains the source of truth for forensic events; this file is for
   * human-friendly tailing only.
   */
  filePath?: string;
}

export interface OperatorLogger {
  readonly includeContent: boolean;
  preview(value: string | undefined): string | undefined;
  banner(fields: Record<string, LogValue>): void;
  info(event: string, fields?: Record<string, LogValue>): void;
  debug(event: string, fields?: Record<string, LogValue>): void;
  error(event: string, fields?: Record<string, LogValue>): void;
}

export type LogValue = string | number | boolean | undefined | null | readonly string[];
type LogSeverity = "info" | "debug" | "error";

const icons: Record<string, string> = {
  // gemini-claw originals (kept verbatim for reuse where the event still applies)
  startup: "╭─",
  chat_request: "📨",
  chat_reply: "📤",
  chat_error: "💥",
  task_queued: "🚀",
  task_running: "⚙️",
  task_rejected: "⛔",
  command: "⌘",
  gemini_start: "🧠",
  gemini_done: "✨",
  gemini_error: "⚠️",
  tool_start: "🔧",
  tool_end: "✅",
  subagent: "🤖",
  reset: "♻️",

  // pi-comms additions — daemon lifecycle
  daemon_boot: "🟢",
  daemon_shutdown: "🔴",
  pointer_loaded: "📒",
  pointer_corrupt: "💥",

  // task lifecycle (overrides shared with gemini-claw vocabulary)
  task_started: "🚀",
  task_completed: "✅",
  task_failed: "💥",
  task_cancelled: "🛑",
  auto_promote_fired: "⏰",
  go_background_called: "📤",

  // tell / confirm tooling
  tell_emit: "📱",
  confirm_request: "❓",
  confirm_resolved: "✔️",
  confirm_timed_out: "⏰",

  // classifier / guard rejects
  classifier_block: "🛡️",
  classifier_confirm_required: "⚠️",
  allowlist_reject: "⛔",
  dm_only_reject: "⛔",

  // channels
  whatsapp_connect: "🔗",
  whatsapp_disconnect: "🔌",
  whatsapp_reauth_needed: "🔑",
  telegram_connect: "🔗",
  telegram_disconnect: "🔌",

  // studio health
  studio_health_ok: "💚",
  studio_health_fail: "💔",
  studio_recovered: "💚",

  // pi worker liveness
  pi_heartbeat: "💓",
  pi_stuck_suspected: "🤔",

  // session lifecycle
  session_recreate: "♻️",
  autocompaction_detected: "🗜️",

  // sandbox / unsand state
  unsand_enabled: "🔓",
  unsand_disabled: "🔒",
  sandbox_force_engaged_on_boot: "🔒",

  // additional event-vocabulary alignments (audit schema parity)
  confirm_rejected: "⛔",
  prompt_version_changed: "📝",
  serial_queue_blocked: "⏸️",
  task_abandoned_on_restart: "🔁",
  lock_engaged_reject: "🛡️",
  ipc_attach: "🔌",
  ipc_detach: "🔌",
};

export function createOperatorLogger(options: OperatorLoggerOptions): OperatorLogger {
  const consoleWrite = options.write ?? ((line: string) => console.log(line));
  // AUDIT-A #18: if filePath set, ensure parent dir exists once at
  // construction.  We use sync mkdir/append because the operator logger
  // is on every event path and async fs would burn an extra microtask
  // per call; failures are swallowed because this file is convenience,
  // not the audit log.
  if (options.filePath) {
    try {
      mkdirSync(dirname(options.filePath), { recursive: true, mode: 0o700 });
    } catch {
      /* best-effort */
    }
  }
  const teeFile = (line: string) => {
    if (!options.filePath) return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const target = `${options.filePath}.${today}`;
    try {
      appendFileSync(target, line + "\n", { mode: 0o600 });
    } catch {
      /* best-effort — operator log is convenience, not source-of-truth */
    }
  };
  const write = (line: string) => {
    consoleWrite(line);
    teeFile(line);
  };

  const logger: OperatorLogger = {
    includeContent: options.includeContent,
    preview(value) {
      return previewText(value, options.previewChars, options.includeContent);
    },
    banner(fields) {
      if (options.level === "silent") return;

      if (options.style === "json") {
        writeJson(write, "startup", "info", fields);
        return;
      }

      if (options.style === "plain") {
        write(formatPlain("startup", "info", fields));
        return;
      }

      const bot = formatValue(fields.bot) ?? "unknown";
      const mode = formatValue(fields.mode) ?? "default";
      const workers = formatValue(fields.workers) ?? "0/0";
      const model = formatValue(fields.model) ?? "pi-mono default";
      const sessions = formatValue(fields.sessions) ?? "isolated";
      const extensions = formatValue(fields.extensions) ?? "0";
      write("╭─ pi-comms online ────────────────────────────────╮");
      write(`│ bot=${padRight(bot, 18)} mode=${padRight(mode, 8)} workers=${padRight(workers, 7)} │`);
      write(`│ model=${padRight(model, 17)} sessions=${padRight(sessions, 10)} ext=${padRight(extensions, 4)} │`);
      write("╰──────────────────────────────────────────────────╯");
    },
    info(event, fields) {
      writeEvent(options, write, event, "info", fields);
    },
    debug(event, fields) {
      writeEvent(options, write, event, "debug", fields);
    },
    error(event, fields) {
      writeEvent(options, write, event, "error", fields);
    },
  };

  return logger;
}

export const noopOperatorLogger: OperatorLogger = {
  includeContent: false,
  preview() {
    return undefined;
  },
  banner() {
    return undefined;
  },
  info() {
    return undefined;
  },
  debug() {
    return undefined;
  },
  error() {
    return undefined;
  },
};

function writeEvent(
  options: OperatorLoggerOptions,
  write: (line: string) => void,
  event: string,
  severity: LogSeverity,
  fields: Record<string, LogValue> | undefined
): void {
  if (!shouldLog(options.level, severity)) return;

  const safeFields = fields ?? {};
  if (options.style === "json") {
    writeJson(write, event, severity, safeFields);
    return;
  }

  write(
    options.style === "plain"
      ? formatPlain(event, severity, safeFields)
      : formatPretty(event, severity, safeFields)
  );
}

function shouldLog(level: OperatorLogLevel, severity: LogSeverity): boolean {
  if (level === "silent") return false;
  if (severity === "error") return true;
  if (level === "debug") return true;
  return severity === "info";
}

function formatPretty(event: string, severity: LogSeverity, fields: Record<string, LogValue>): string {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const icon = icons[event] ?? (severity === "error" ? "⚠️" : "•");
  const label = event.replace(/_/g, " ");
  const payload = formatFields(fields);
  return `${time}  ${icon} ${padRight(label, 18)}${payload ? ` ${payload}` : ""}`;
}

function formatPlain(event: string, severity: LogSeverity, fields: Record<string, LogValue>): string {
  const payload = formatFields(fields);
  return `[${severity}] ${event}${payload ? ` ${payload}` : ""}`;
}

function writeJson(
  write: (line: string) => void,
  event: string,
  severity: LogSeverity,
  fields: Record<string, LogValue>
): void {
  write(JSON.stringify({ ts: new Date().toISOString(), level: severity, event, ...compactFields(fields) }));
}

function formatFields(fields: Record<string, LogValue>): string {
  return Object.entries(compactFields(fields))
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function compactFields(fields: Record<string, LogValue>): Record<string, Exclude<LogValue, undefined | null>> {
  const compacted: Record<string, Exclude<LogValue, undefined | null>> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      compacted[key] = value;
    }
  }
  return compacted;
}

function formatValue(value: LogValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.length > 0 ? value.join(",") : "none";
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  return String(value);
}

function previewText(value: string | undefined, maxLength: number, includeContent: boolean): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (includeContent || compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}
