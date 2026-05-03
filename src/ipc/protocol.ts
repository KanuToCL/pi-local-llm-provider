/**
 * IPC verb schemas + token helpers.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"Daemon ↔ CLI IPC contract" (line 251): newline-delimited JSON over a
 *     Unix domain socket (or named pipe on Windows). Each line is one
 *     `ClientReq` from the CLI or one `ServerResp` from the daemon.
 *   - §"v4 changelog" Architect/IPC backpressure verbs (line 1308): adds
 *     `pause` / `resume` and an explicit `lag_ms` field on event responses.
 *   - §"v4 changelog" Adversarial — IPC same-UID privesc (line 1293) +
 *     Pitfall #24: chmod-600 on the socket is necessary but not sufficient
 *     on shared boxes; every `attach` also presents a per-user auth token
 *     that the daemon validates.
 *   - §"v4.2" + Pitfall #30 (line 1270): the status pointer is updated only
 *     through the daemon-mediated `pointer-write` IPC verb so that the
 *     `JsonSessionStore` write queue is the single serialization point.
 *
 * Versioning:
 *   - This is the v1 IPC surface; the daemon and CLI MUST agree on it.
 *     Any breaking change requires a v2 of the schema and a backward-
 *     compatible attach handshake. For v1, mismatches surface as zod
 *     parse errors and the connection is closed with an `ErrorResp`.
 *
 * Threat model summary:
 *   - The socket file lives in `~/.pi-comms/` (mode 0700 dir + mode 0600
 *     socket). On a single-user box, OS permissions are the auth boundary.
 *   - On a shared-UID box (containers, root cohabitants, dev VMs with
 *     multiple agents under the same UID), the per-connection auth token
 *     in `~/.pi-comms/ipc-token` (mode 0600) is the second factor. A
 *     process running as the same UID could in theory read the token —
 *     this is a known limitation, documented in Pitfall #24.
 */

import { createReadStream, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Client → Server requests
// ---------------------------------------------------------------------------

/**
 * Begin streaming events. Filter via `stream`:
 *   - `'all'` — terminal-style firehose (every channel event).
 *   - `'tell-only'` — surfaces only `tell()` and `confirm()` outputs (the
 *     filter the WhatsApp/Telegram-like sinks would use).
 *
 * `authToken` MUST match the contents of `~/.pi-comms/ipc-token`. The
 * daemon will close the connection on mismatch (Pitfall #24). `clientName`
 * is optional and used only for ops log lines (e.g. "attached: pi-comms-cli").
 */
export const AttachReq = z.object({
  verb: z.literal("attach"),
  stream: z.enum(["all", "tell-only"]),
  authToken: z.string().min(8),
  clientName: z.string().max(64).optional(),
});

/** Inject a user message into the shared agent session. */
export const SendReq = z.object({
  verb: z.literal("send"),
  text: z.string().min(1).max(50_000),
});

/** One-shot status snapshot. The response carries a `summary` + raw `taskState`. */
export const StatusReq = z.object({ verb: z.literal("status") });

/** Last-N audit / event entries. `limit` is bounded to avoid runaway responses. */
export const HistoryReq = z.object({
  verb: z.literal("history"),
  limit: z.number().int().min(1).max(1000),
});

/** Close this CLI connection. The daemon stays running. */
export const DetachReq = z.object({ verb: z.literal("detach") });

/**
 * Graceful daemon stop. Admin-only — requires the auth token (same value
 * the `attach` handshake uses) so that anyone who reached the socket but
 * not the home dir cannot kill the daemon.
 */
export const ShutdownReq = z.object({
  verb: z.literal("shutdown"),
  authToken: z.string().min(8),
});

/**
 * Backpressure: ask the daemon to stop pushing events to this connection.
 * The daemon keeps a per-attached-client bounded buffer; while paused, new
 * events accumulate until the buffer cap, then the oldest are dropped and
 * an `attached_client_buffer_overflow` audit row is written (Architect
 * Round-1 IPC backpressure recommendation).
 */
export const PauseReq = z.object({ verb: z.literal("pause") });

/** Resume event delivery to this connection (drains the bounded buffer). */
export const ResumeReq = z.object({ verb: z.literal("resume") });

/**
 * Daemon-mediated status pointer write.
 *
 * Per Pitfall #30 (line 1270): the agent does NOT write the pointer file
 * directly. The status-pointer writer lives behind a single
 * `JsonSessionStore`-style write queue that the daemon owns; clients
 * (including pi itself, via a tool registered in W2) submit text via
 * this verb. The daemon truncates per the 2000-grapheme cap (Data
 * Guardian) and reports back whether it had to truncate.
 */
export const PointerWriteReq = z.object({
  verb: z.literal("pointer-write"),
  body: z.string(),
});

/** All client → daemon verbs in one discriminated union. */
export const ClientReq = z.discriminatedUnion("verb", [
  AttachReq,
  SendReq,
  StatusReq,
  HistoryReq,
  DetachReq,
  ShutdownReq,
  PauseReq,
  ResumeReq,
  PointerWriteReq,
]);
export type ClientReq = z.infer<typeof ClientReq>;

// ---------------------------------------------------------------------------
// Server → Client responses
// ---------------------------------------------------------------------------

/**
 * Streamed event. `lag_ms = Date.now() - event.ts` measured at the moment
 * the daemon serialized the line. A persistently-growing `lag_ms` on a
 * client is a self-monitoring signal that the client should `pause` or
 * close — see Architect Round-1 backpressure note (line 1308).
 */
export const EventResp = z.object({
  verb: z.literal("event"),
  type: z.string(),
  payload: z.unknown(),
  ts: z.number(),
  lag_ms: z.number(),
});

/** Snapshot reply for `status`. `taskState` is opaque (validated by W2 elsewhere). */
export const StatusResp = z.object({
  verb: z.literal("status"),
  summary: z.string(),
  taskState: z.unknown(),
});

/** Reply for `history`. `entries` is an array of opaque audit/event objects. */
export const HistoryResp = z.object({
  verb: z.literal("history"),
  entries: z.array(z.unknown()),
});

/** Acknowledgement reply for verbs that do not carry data (attach/send/detach/etc). */
export const AckResp = z.object({
  verb: z.literal("ack"),
  of: z.string(),
});

/**
 * Error reply. `of` is the verb the client sent, when known. `message` is
 * a human-friendly diagnostic — never includes raw user text or secrets.
 */
export const ErrorResp = z.object({
  verb: z.literal("error"),
  of: z.string().optional(),
  message: z.string(),
});

/** Reply payload for `pointer-write` — reports whether truncation occurred. */
export const PointerWriteResp = z.object({
  verb: z.literal("pointer-write"),
  written: z.boolean(),
  truncated: z.boolean(),
});

/** All daemon → client verbs in one discriminated union. */
export const ServerResp = z.discriminatedUnion("verb", [
  EventResp,
  StatusResp,
  HistoryResp,
  AckResp,
  ErrorResp,
  PointerWriteResp,
]);
export type ServerResp = z.infer<typeof ServerResp>;

// ---------------------------------------------------------------------------
// Token helpers (Pitfall #24)
// ---------------------------------------------------------------------------

/** Generate a fresh 32-byte hex token (256 bits of entropy). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Read the IPC auth token from `tokenPath` (typically
 * `~/.pi-comms/ipc-token`). Throws if the file is missing — callers should
 * use `ensureTokenFile` at boot to materialize one if needed.
 *
 * Streamed read keeps the token out of any error message produced by
 * `readFile` (which on some Node versions echoes the file path), and
 * trims trailing whitespace so a manual `echo "..." > ipc-token` doesn't
 * accidentally bake in a `\n`.
 */
export async function readToken(tokenPath: string): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(tokenPath, { encoding: undefined });
    stream.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve());
    stream.on("error", (err) => reject(err));
  });
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Ensure the token file exists at `tokenPath`. If absent, create the
 * parent directory (mode 0700) and write a fresh token at mode 0600.
 * Returns the token (existing or freshly generated).
 *
 * On Windows, file modes are advisory — Node's `chmod` is a no-op for
 * many cases; relying on Windows ACLs would be the correct hardening
 * but is out of scope for v1 (documented in plan §"Out of scope" for
 * the cross-OS lifecycle work).
 */
export async function ensureTokenFile(tokenPath: string): Promise<string> {
  try {
    const existing = await readToken(tokenPath);
    if (existing.length >= 8) return existing;
  } catch (err) {
    if (!isNoEnt(err)) throw err;
  }

  const token = generateToken();
  await fs.mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  // Write with mode 0600 atomically (open+write+close in one shot).
  await fs.writeFile(tokenPath, token, { mode: 0o600, flag: "w" });
  // Defensive chmod in case the file already existed with a wider mode.
  try {
    await fs.chmod(tokenPath, 0o600);
  } catch {
    /* best-effort on platforms (Windows) where chmod is advisory */
  }
  return token;
}

function isNoEnt(err: unknown): boolean {
  return (
    err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
