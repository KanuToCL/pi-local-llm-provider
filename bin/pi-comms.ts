#!/usr/bin/env node
/**
 * pi-comms — thin CLI client.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md §"Daemon ↔ CLI IPC contract"
 * (line 251) and the IMPL-16 W4 brief: this is the user-facing entry that
 * connects to the daemon's Unix socket / Windows named pipe and shells out
 * the high-level verbs the daemon exposes (attach / status / send /
 * history / shutdown / unlock / doctor).
 *
 * Defaults:
 *   - With no subcommand, runs `pi-comms attach` (UX Advocate Round-1: this
 *     should feel like `tmux attach`).
 *   - `attach` defaults to `stream='tell-only'` per UX Advocate Round-1 MED
 *     (content-off default); `--full` opts into the firehose (`stream='all'`).
 *
 * Token loading:
 *   - The auth token lives at `~/.pi-comms/ipc-token` (mode 0600). The CLI
 *     refuses to run if the file is missing — the user is told to start the
 *     daemon first (which materializes the token).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { AuditLog } from "../src/audit/log.js";
import { IpcClient } from "../src/ipc/client.js";
import { readToken } from "../src/ipc/protocol.js";
import {
  ModelsJsonValidationError,
  loadAndValidateModelsJson,
} from "../src/lib/sdk-models-validator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HOME = process.env.PI_COMMS_HOME ?? join(homedir(), ".pi-comms");

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function defaultSocketPath(): string {
  if (platform() === "win32") return "\\\\.\\pipe\\pi-comms";
  return join(DEFAULT_HOME, "daemon.sock");
}

function tokenPath(): string {
  return join(DEFAULT_HOME, "ipc-token");
}

async function loadAuthToken(): Promise<string> {
  const path = tokenPath();
  if (!existsSync(path)) {
    process.stderr.write(
      `pi-comms: auth token not found at ${path}.\n` +
        "Start the daemon first (e.g. \`npm run daemon\`) — it will materialize the token.\n"
    );
    process.exit(2);
  }
  return readToken(path);
}

// ---------------------------------------------------------------------------
// Pretty-format inbound events for stdout
// ---------------------------------------------------------------------------

function eventIcon(type: string): string {
  switch (type) {
    case "tell":
      return "[tell]   ";
    case "confirm_request":
      return "[confirm]";
    case "auto_promote_notice":
      return "[bg?]    ";
    case "go_background_notice":
      return "[bg]     ";
    case "reply":
      return "[reply]  ";
    case "task_completed":
      return "[done]   ";
    case "system_notice":
      return "[sys]    ";
    default:
      return `[${type}] `.padEnd(9, " ");
  }
}

function summarizeEvent(
  type: string,
  payload: Record<string, unknown>,
  full: boolean
): string {
  const icon = eventIcon(type);
  if (type === "tell") {
    const urgency = String(payload.urgency ?? "info");
    const text = String(payload.text ?? "");
    return `${icon} (${urgency}) ${full ? text : truncate(text, 120)}`;
  }
  if (type === "confirm_request") {
    const id = String(payload.shortId ?? "?");
    const q = String(payload.question ?? "");
    return `${icon} ${id} ${full ? q : truncate(q, 100)}`;
  }
  if (type === "reply") {
    const text = String(payload.text ?? "");
    return `${icon} ${full ? text : truncate(text, 200)}`;
  }
  if (type === "system_notice") {
    const level = String(payload.level ?? "info");
    const text = String(payload.text ?? "");
    return `${icon} (${level}) ${text}`;
  }
  if (type === "task_completed") {
    const id = String(payload.taskId ?? "?");
    const final = String(payload.finalMessage ?? "");
    return `${icon} ${id} — ${full ? final : truncate(final, 200)}`;
  }
  if (type === "auto_promote_notice") {
    return `${icon} firing=${payload.firingNumber} age=${payload.taskAgeSeconds}s`;
  }
  if (type === "go_background_notice") {
    const preview = String(payload.userMessagePreview ?? "");
    return `${icon} (was: ${truncate(preview, 60)})`;
  }
  return `${icon} ${JSON.stringify(payload)}`;
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return compact.slice(0, Math.max(0, max - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

interface AttachOptions {
  full: boolean;
  socketPath: string;
  authToken: string;
}

async function runAttach(opts: AttachOptions): Promise<number> {
  const stream: "all" | "tell-only" = opts.full ? "all" : "tell-only";
  const client = new IpcClient({
    socketPath: opts.socketPath,
    authToken: opts.authToken,
    onEvent: (type, payload) => {
      process.stdout.write(
        summarizeEvent(type, payload as Record<string, unknown>, opts.full) +
          "\n"
      );
    },
    onError: (msg) => {
      process.stderr.write(`pi-comms: ${msg}\n`);
    },
  });

  try {
    await client.attach(stream, "pi-comms-cli");
  } catch (err) {
    process.stderr.write(
      `pi-comms: attach failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return 1;
  }
  process.stdout.write(
    `pi-comms: attached (stream=${stream}). Type a message (Ctrl-C to detach).\n`
  );

  // Pipe stdin lines → IpcClient.send.
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";
  stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        await client.send(trimmed);
      } catch (err) {
        process.stderr.write(
          `pi-comms: send failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        );
      }
    }
  });

  return new Promise<number>((resolve) => {
    const onShutdown = async () => {
      try {
        await client.detach();
      } catch {
        /* daemon may already have closed */
      }
      resolve(0);
    };
    process.once("SIGINT", () => void onShutdown());
    process.once("SIGTERM", () => void onShutdown());
    stdin.on("end", () => void onShutdown());
  });
}

async function runStatus(socketPath: string, authToken: string): Promise<number> {
  const client = new IpcClient({ socketPath, authToken });
  try {
    await client.attach("tell-only", "pi-comms-cli-status");
    const snap = await client.status();
    process.stdout.write(`${snap.summary}\n`);
    process.stdout.write(`taskState: ${JSON.stringify(snap.taskState)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `pi-comms: status failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return 1;
  } finally {
    client.close();
  }
}

async function runSend(
  text: string,
  socketPath: string,
  authToken: string
): Promise<number> {
  if (!text) {
    process.stderr.write("pi-comms: send requires non-empty text.\n");
    return 2;
  }
  const client = new IpcClient({ socketPath, authToken });
  try {
    await client.attach("tell-only", "pi-comms-cli-send");
    await client.send(text);
    process.stdout.write("ok\n");
    return 0;
  } catch (err) {
    process.stderr.write(
      `pi-comms: send failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return 1;
  } finally {
    client.close();
  }
}

async function runHistory(
  limit: number,
  socketPath: string,
  authToken: string
): Promise<number> {
  const client = new IpcClient({ socketPath, authToken });
  try {
    await client.attach("tell-only", "pi-comms-cli-history");
    const entries = await client.history(limit);
    for (const e of entries) process.stdout.write(`${JSON.stringify(e)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `pi-comms: history failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return 1;
  } finally {
    client.close();
  }
}

async function runShutdown(
  socketPath: string,
  authToken: string
): Promise<number> {
  const client = new IpcClient({ socketPath, authToken });
  try {
    await client.attach("tell-only", "pi-comms-cli-shutdown");
    await client.shutdown();
    process.stdout.write("daemon shutting down.\n");
    return 0;
  } catch (err) {
    process.stderr.write(
      `pi-comms: shutdown failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return 1;
  } finally {
    client.close();
  }
}

async function runUnlock(
  socketPath: string,
  authToken: string
): Promise<number> {
  // RS-2: /unlock is gated terminal-only by the slash router. We send the
  // slash command through the IPC `send` verb so the daemon's slash router
  // sees `isTerminal=true`.
  const client = new IpcClient({ socketPath, authToken });
  try {
    await client.attach("tell-only", "pi-comms-cli-unlock");
    await client.send("/unlock");
    process.stdout.write("unlock requested.\n");
    return 0;
  } catch (err) {
    process.stderr.write(
      `pi-comms: unlock failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return 1;
  } finally {
    client.close();
  }
}

/**
 * FIX-B-2 #1: `pi-comms purge [--older-than=N]`.
 *
 * Construct an AuditLog pointing at `<HOME>/audit` and call
 * `purgeOlderThan(N)`.  Default N=90 days (matches AuditLog's own default
 * and `PI_COMMS_AUDIT_RETENTION_DAYS`).  This runs WITHOUT touching the
 * daemon — purely filesystem-side — so an operator can reclaim disk even
 * when the daemon is down.
 */
async function runPurge(olderThanDays: number): Promise<number> {
  const auditDir = join(DEFAULT_HOME, "audit");
  if (!existsSync(auditDir)) {
    process.stdout.write(`pi-comms: audit dir not present (${auditDir}); nothing to purge.\n`);
    return 0;
  }
  const log = new AuditLog({
    dir: auditDir,
    // daemonStartTs irrelevant for purge — only `dir` and the call argument matter.
    daemonStartTs: Date.now(),
    retentionDays: olderThanDays,
  });
  try {
    const purged = await log.purgeOlderThan(olderThanDays);
    process.stdout.write(
      `pi-comms: purged ${purged} audit log file(s) older than ${olderThanDays} day(s).\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `pi-comms: purge failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

async function runDoctor(): Promise<number> {
  const lines: string[] = [];
  let ok = true;

  // 1. ~/.pi-comms exists?
  if (existsSync(DEFAULT_HOME)) {
    lines.push(`OK   home dir present at ${DEFAULT_HOME}`);
  } else {
    lines.push(
      `WARN home dir missing at ${DEFAULT_HOME} (start the daemon to create)`
    );
    ok = false;
  }

  // 2. Token file?
  const tp = tokenPath();
  if (existsSync(tp)) {
    lines.push(`OK   ipc-token present`);
  } else {
    lines.push(`WARN ipc-token missing at ${tp}`);
    ok = false;
  }

  // 3. Models.json validates?
  const modelsPath =
    process.env.PI_MODELS_JSON ?? join(homedir(), ".pi", "agent", "models.json");
  try {
    await loadAndValidateModelsJson(modelsPath);
    lines.push(`OK   models.json schema valid (${modelsPath})`);
  } catch (err) {
    if (err instanceof ModelsJsonValidationError) {
      lines.push(`FAIL models.json invalid: ${err.message}`);
    } else {
      lines.push(
        `FAIL models.json could not be loaded: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    ok = false;
  }

  // 4. Studio reachable? (best-effort)
  try {
    const cfg = await loadAndValidateModelsJson(modelsPath).catch(() => null);
    if (cfg) {
      const firstProvider = Object.values(cfg.providers)[0] as
        | { baseUrl?: string }
        | undefined;
      const baseUrl = firstProvider?.baseUrl;
      if (baseUrl) {
        const root = baseUrl.replace(/\/v1\/?$/, "");
        try {
          const res = await fetch(`${root}/api/inference/status`);
          if (res.ok) {
            const data = (await res.json().catch(() => ({}))) as Record<
              string,
              unknown
            >;
            const loaded = Array.isArray(data.loaded) ? data.loaded : [];
            lines.push(`OK   Studio reachable (loaded=${loaded.length} model(s))`);
          } else {
            lines.push(`WARN Studio responded HTTP ${res.status} at ${root}`);
          }
        } catch (err) {
          lines.push(
            `WARN Studio not reachable at ${root}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
  } catch {
    /* already reported via models.json line */
  }

  for (const line of lines) process.stdout.write(line + "\n");
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(
    [
      "pi-comms — thin CLI for the pi-comms daemon",
      "",
      "Usage:",
      "  pi-comms                       # alias for `attach`",
      "  pi-comms attach [--full]       # attach to the daemon's event stream",
      "  pi-comms status                # one-shot daemon status",
      "  pi-comms send <text>           # one-shot inject a user message",
      "  pi-comms history [N]           # last N audit/event entries (default 20)",
      "  pi-comms shutdown              # graceful daemon stop",
      "  pi-comms unlock                # /unlock from terminal (RS-2)",
      "  pi-comms doctor                # diagnostics (no daemon required)",
      "  pi-comms purge [--older-than=N] # delete audit logs older than N days (default 90)",
    ].join("\n") + "\n"
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  // doctor, purge, + help do not require a token (purge is purely a
  // filesystem op; it doesn't touch the daemon).
  if (sub === "doctor") return runDoctor();
  if (sub === "purge") {
    const rest = argv.slice(1);
    const parsed = parseArgs({
      args: rest,
      options: {
        "older-than": { type: "string", default: "90" },
      },
      allowPositionals: true,
    });
    const raw = String(parsed.values["older-than"] ?? "90");
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(
        `pi-comms: --older-than must be a positive number; got '${raw}'.\n`,
      );
      return 2;
    }
    return runPurge(Math.floor(n));
  }
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printUsage();
    return 0;
  }

  const socketPath = defaultSocketPath();

  // Token required for all daemon-touching subcommands.
  const authToken = await loadAuthToken();

  if (!sub || sub === "attach") {
    // parseArgs against argv minus the subcommand.
    const rest = sub === "attach" ? argv.slice(1) : argv.slice(0);
    const parsed = parseArgs({
      args: rest,
      options: { full: { type: "boolean", default: false } },
      allowPositionals: true,
    });
    return runAttach({
      full: !!parsed.values.full,
      socketPath,
      authToken,
    });
  }

  if (sub === "status") return runStatus(socketPath, authToken);
  if (sub === "send") {
    const text = argv.slice(1).join(" ");
    return runSend(text, socketPath, authToken);
  }
  if (sub === "history") {
    const limitArg = argv[1];
    let limit = 20;
    if (limitArg !== undefined) {
      const n = Number(limitArg);
      if (Number.isFinite(n) && n > 0) limit = Math.min(1000, Math.floor(n));
    }
    return runHistory(limit, socketPath, authToken);
  }
  if (sub === "shutdown") return runShutdown(socketPath, authToken);
  if (sub === "unlock") return runUnlock(socketPath, authToken);

  process.stderr.write(`pi-comms: unknown subcommand '${sub}'.\n\n`);
  printUsage();
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `pi-comms: unexpected error: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }\n`
    );
    process.exit(1);
  }
);
