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

/**
 * Hard cap on the JSON-encoded size of `extra` plus `error_class` (FIX-B-2 #3).
 * 8KB chosen because:
 *   - The audit log is JSONL on a single-user box; lines that approach this
 *     are almost certainly a runaway `extra` field (stack trace dump, base64
 *     blob, raw command output) — the kind of thing that benefits more from
 *     a marker than from full preservation.
 *   - 8KB still leaves comfortable headroom under the 16KB pipe-buffer
 *     write boundary on Linux/macOS so a single append() never spans atomicity.
 */
const EXTRA_SIZE_CAP_BYTES = 8 * 1024;
/** Per-string cap before any aggregate cap kicks in. */
const PER_STRING_CAP_BYTES = 8 * 1024;

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
    // FIX-B-2 #3: cap any string in `extra` and `error_class` so a runaway
    // payload (10MB stack-trace, raw command output) cannot bloat the JSONL
    // line beyond the 8KB budget.  We mutate a shallow copy — never the
    // caller's object.
    const capped = capEntrySizes(entry);
    // AUDIT-A spread-order fix: caller-provided fields go FIRST, daemon-
    // computed timestamps go LAST so a buggy caller cannot accidentally
    // forge `ts` or `daemon_uptime_s` by passing them in `entry`.
    const full: AuditEntry = {
      ...capped,
      ts: now.toISOString(),
      daemon_uptime_s: Math.max(
        0,
        Math.floor((now.getTime() - this.daemonStartTs) / 1000),
      ),
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

/**
 * Truncate a string to `max` UTF-8 bytes, replacing the tail with a
 * `[TRUNCATED:NNNbytes]` marker that records the dropped byte count.
 *
 * We use Buffer.byteLength because JS string `.length` counts UTF-16 code
 * units, not bytes — an emoji or CJK char would otherwise be undercounted
 * against the 8KB cap and the resulting JSONL line could still blow past it.
 */
function truncateStringToBytes(value: string, max: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= max) return value;
  // Reserve room for the marker so the final string fits under `max`.
  const markerSuffix = `[TRUNCATED:${bytes}bytes]`;
  const markerBytes = Buffer.byteLength(markerSuffix, "utf8");
  const allowance = Math.max(0, max - markerBytes);
  // Slice on the byte-encoded form to avoid splitting a multi-byte codepoint
  // across the cut.
  const buf = Buffer.from(value, "utf8");
  let cut = Math.min(allowance, buf.length);
  // Walk back if we're sitting in the middle of a UTF-8 continuation byte
  // (high two bits == 10).  Up to 3 walk-backs suffice for any codepoint.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1;
  return buf.slice(0, cut).toString("utf8") + markerSuffix;
}

/**
 * Apply size caps before validation:
 *   1. Each string in `extra` capped at PER_STRING_CAP_BYTES (8KB).
 *   2. `error_class` capped at PER_STRING_CAP_BYTES.
 *   3. If the JSON-encoded `extra` still exceeds EXTRA_SIZE_CAP_BYTES, drop
 *      offending fields in priority order (longest first) — replace each with
 *      a `[TRUNCATED:NNNbytes]` placeholder until the encoded blob is under
 *      cap.  Non-string values (numbers, booleans) are tiny and not capped.
 */
function capEntrySizes(
  entry: Omit<AuditEntry, "ts" | "daemon_uptime_s">,
): Omit<AuditEntry, "ts" | "daemon_uptime_s"> {
  const out: Omit<AuditEntry, "ts" | "daemon_uptime_s"> = { ...entry };

  if (typeof out.error_class === "string") {
    out.error_class = truncateStringToBytes(
      out.error_class,
      PER_STRING_CAP_BYTES,
    );
  }

  if (out.extra) {
    // Step 1: per-field cap.
    const cappedExtra: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(out.extra)) {
      if (typeof v === "string") {
        cappedExtra[k] = truncateStringToBytes(v, PER_STRING_CAP_BYTES);
      } else {
        cappedExtra[k] = v;
      }
    }

    // Step 2: aggregate cap.  Drop the longest string fields first until the
    // serialized `extra` is under the cap.
    while (
      Buffer.byteLength(JSON.stringify(cappedExtra), "utf8") >
      EXTRA_SIZE_CAP_BYTES
    ) {
      const stringFields = Object.entries(cappedExtra)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => ({ key: k, len: Buffer.byteLength(v as string, "utf8") }))
        .sort((a, b) => b.len - a.len);
      if (stringFields.length === 0) break; // only non-strings left; nothing to drop
      const victim = stringFields[0];
      cappedExtra[victim.key] = `[TRUNCATED:${victim.len}bytes]`;
    }

    out.extra = cappedExtra;
  }

  return out;
}
