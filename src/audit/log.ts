/**
 * Audit log writer (JSONL with daily rotation).
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - Pitfall #13 (line 765): daily rotation `audit.YYYY-MM-DD.jsonl`,
 *     old logs gitignored.
 *   - Pitfall #28 (line 1268): every line is `JSON.stringify`-encoded
 *     so attacker-controlled message text cannot inject a forged
 *     event by smuggling a `\n{"event":"..."}` payload — JSON
 *     stringification escapes the embedded newline as `\n`, keeping
 *     the JSONL frame intact (one entry per line).
 *   - Observability rows (line 1346 ff.): typed AuditEntry with
 *     duration_ms latency instrumentation, sender_id hashing.
 *   - §"Retention" (line 1251): 90-day default purge surfaced via
 *     `purgeOlderThan(days)`.
 *
 * Threading model:
 *   - Per-instance write queue serializes appends within one process.
 *   - Daily rotation is decided at append time from a fresh `Date`,
 *     so the writer never wedges across midnight.
 *
 * Limitations:
 *   - The writer does NOT fsync. fsync-on-every-write would make the
 *     writer ~100x slower and is not warranted for an audit log on
 *     a single-user box; the kernel page cache flushes within seconds.
 */

import { createHash } from "node:crypto";
import { mkdir, appendFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

import { AuditEntry, AuditEntrySchema } from "./schema.js";

export interface AuditLogOptions {
  /** Directory for `audit.YYYY-MM-DD.jsonl` files. Created if missing. */
  dir: string;
  /**
   * `Date.now()`-style millisecond timestamp captured at daemon start.
   * Used to compute `daemon_uptime_s` per entry without relying on
   * `process.uptime()` (which can drift if the host suspends).
   */
  daemonStartTs: number;
  /** Days of history kept by `purgeOlderThan`. Default 90. */
  retentionDays?: number;
}

/**
 * Pattern matched by `purgeOlderThan` and used by `currentLogPath`.
 * Matches `audit.YYYY-MM-DD.jsonl` (10 chars of date), nothing else.
 */
const FILENAME_RE = /^audit\.(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class AuditLog {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly dir: string;
  private readonly daemonStartTs: number;
  readonly retentionDays: number;

  constructor(opts: AuditLogOptions) {
    this.dir = opts.dir;
    this.daemonStartTs = opts.daemonStartTs;
    this.retentionDays = opts.retentionDays ?? 90;
  }

  /** Path of the JSONL file that today's entries land in. */
  currentLogPath(now: Date = new Date()): string {
    return join(this.dir, `audit.${formatDateUtc(now)}.jsonl`);
  }

  /**
   * Append one entry. The caller supplies everything except `ts` and
   * `daemon_uptime_s`, which are stamped here. The full entry is then
   * validated against `AuditEntrySchema` (so a stray bad event kind or
   * a non-scalar `extra` value throws BEFORE hitting disk) and written
   * as a single `JSON.stringify`d line followed by `\n`.
   *
   * Per Pitfall #28: this is the ONLY supported path for writing audit
   * lines. Never concatenate raw message text into the file.
   */
  async append(entry: Omit<AuditEntry, "ts" | "daemon_uptime_s">): Promise<void> {
    const now = new Date();
    const full: AuditEntry = {
      ts: now.toISOString(),
      daemon_uptime_s: Math.max(
        0,
        Math.floor((now.getTime() - this.daemonStartTs) / 1000)
      ),
      ...entry,
    };

    // Validate first — throws ZodError synchronously if shape is wrong.
    // This is intentional: a malformed audit append is a code bug we
    // want to surface in tests, not silently swallow.
    const validated = AuditEntrySchema.parse(full);

    // JSON.stringify produces no embedded raw newlines (newlines in
    // string values are escaped to \n). One entry == one line.
    const line = `${JSON.stringify(validated)}\n`;

    return this.enqueueWrite(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.currentLogPath(now), line, "utf8");
    });
  }

  /**
   * Delete `audit.YYYY-MM-DD.jsonl` files older than `days` days.
   * Returns the number of files deleted. Files that don't match the
   * naming convention are left alone. A single failed unlink does not
   * abort the sweep — best-effort across all candidates.
   */
  async purgeOlderThan(days: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let purged = 0;
    for (const name of entries) {
      const m = FILENAME_RE.exec(name);
      if (!m) continue;
      const fullPath = join(this.dir, name);
      let mtimeMs: number;
      try {
        const st = await stat(fullPath);
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs >= cutoff) continue;
      try {
        await unlink(fullPath);
        purged += 1;
      } catch {
        // best-effort; another sweep can pick it up next time
      }
    }
    return purged;
  }

  /**
   * Compute the salted sender-id hash used by `AuditEntry.sender_id_hash`.
   * Per §"v4 changelog" Observability row (line 1355):
   *   sender_id_hash = SHA256(sender_jid + install_salt)
   *
   * The salt lives at `~/.pi-comms/install.json` and is created once per
   * install — exposing this as a static helper lets non-AuditLog callers
   * (e.g. the WhatsApp / Telegram channel code) hash sender ids before
   * passing them in, without needing access to the writer instance.
   */
  static senderIdHash(jid: string, salt: string): string {
    return createHash("sha256").update(`${jid}${salt}`).digest("hex");
  }

  /** Serialize an async write behind any in-flight one. */
  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
