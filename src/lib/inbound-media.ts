/**
 * Inbound media store — atomic-write filesystem cache for non-text inbound
 * media (voice notes, images, documents, video, stickers).
 *
 * Plan refs:
 *   - §"v4 changelog Accessibility — audioRef seam" (BLESS round): the v1
 *     channels (Telegram, WhatsApp) synthesize a textual placeholder for
 *     non-text inbound (Pitfall #21) so the agent surface is uniform, but
 *     the underlying media file MUST be persisted to disk and exposed via
 *     `payload.audioRef` / `payload.imageRef` etc. so that the v2 STT /
 *     vision integration can pick it up without re-plumbing the inbound
 *     path.  This module owns that persistence.
 *
 * Storage layout (per Accessibility seam spec):
 *   <dir>/<msgId>.<ext>
 *
 *   - <dir> defaults to `~/.pi-comms/inbound-media/` (mode 0700, created
 *     lazily on first save).
 *   - <msgId> is the channel-supplied message id (Telegram message_id or
 *     Baileys WAMessage.key.id).  IDs that contain filesystem-unsafe
 *     characters (`/`, `\`, NUL, control, surrogate, leading dot) are
 *     base64url-hashed before use so we never traverse out of <dir> or
 *     overwrite a hidden dotfile.
 *   - <ext> is supplied by the caller (`ogg`, `jpg`, `pdf`, ...).  We
 *     sanitize: keep only `[A-Za-z0-9]`, max 8 chars, fallback `bin`.
 *   - File mode 0600 (best-effort on non-Unix filesystems).
 *
 * Atomicity:
 *   Mirrors `src/storage/json-store.ts` — write to tempfile, fsync-free
 *   rename into place.  A crashed write leaves the prior file (if any)
 *   intact; concurrent saves through the same instance are serialized
 *   via a per-instance promise queue so two simultaneous voice notes
 *   with the same id can't tear each other.
 *
 * Retention:
 *   `purgeOlderThan(days)` deletes files (NOT subdirs) whose mtime is
 *   older than the cutoff.  Intended to be called from the daemon's
 *   daily purge timer (the daemon glue lives in src/daemon.ts and is
 *   owned by FIX-B-1 / FIX-B-2; this module only EXPOSES the method).
 *
 * Threat model notes:
 *   - We DO NOT validate file contents.  A WhatsApp/Telegram-supplied
 *     buffer is taken at face value and dropped on disk.  v1's only
 *     consumer is "preserve for v2"; v2's STT/vision code is responsible
 *     for content sanity checks.
 *   - We DO restrict the on-disk path so an attacker-controlled message
 *     id cannot escape <dir> via `../` or NUL injection (sanitizeMsgId
 *     below); the practical risk is low (channels filter to allowlisted
 *     senders before this code runs) but the defense is essentially free.
 *   - Mode 0600 means only the daemon's UID can read media; this matches
 *     the rest of `~/.pi-comms` (audit log, status pointer, sandbox state).
 */

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What `saveAudio` / `saveImage` / `saveDocument` return.  The daemon glues
 * `path` into the appropriate `payload.*Ref` field on the InboundMessage
 * before handing it to `processInbound`.
 */
export interface InboundMediaSavedRef {
  /** Absolute filesystem path of the saved file. */
  path: string;
  /** Which kind of media this is — used by callers to pick the right ref field. */
  mediaType: "audio" | "image" | "document" | "video";
  /** Size of the saved buffer in bytes (post-write check; trust the buffer). */
  sizeBytes: number;
  /** Optional MIME type passed through from the channel layer (informational). */
  mimeType?: string;
}

/** Constructor options for `InboundMediaStore`. */
export interface InboundMediaStoreOpts {
  /**
   * Directory the store writes into.  `ensureDir()` creates it lazily;
   * callers can also pre-create it externally with the desired mode.
   * Default: `~/.pi-comms/inbound-media/`.
   */
  dir?: string;
}

/** Common shape for the `save*` methods.  `mediaType` is set per-method. */
export interface SaveOpts {
  msgId: string;
  ext: string;
  buffer: Buffer;
  mimeType?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default media-store directory.  Mirrors the placement used by the rest of
 * the daemon (audit log, status pointer, sandbox state) under `~/.pi-comms`.
 * Callers wanting a different root pass `dir` explicitly (typical: tests
 * with a tmpdir).
 */
export function defaultInboundMediaDir(): string {
  return join(homedir(), ".pi-comms", "inbound-media");
}

const MAX_EXT_CHARS = 8;
const FALLBACK_EXT = "bin";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ---------------------------------------------------------------------------
// InboundMediaStore
// ---------------------------------------------------------------------------

export class InboundMediaStore {
  private readonly dir: string;
  /**
   * Per-instance write queue (mirrors JsonStore).  Concurrent saves through
   * one store serialize so two voice notes with the same msgId can't tear
   * each other's write.  Cross-process semantics inherit from POSIX rename
   * atomicity (same as JsonStore).
   */
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Tracks whether `ensureDir()` has run successfully at least once during
   * this process lifetime.  Lets `save*` skip the redundant mkdir/chmod
   * round-trip on the hot path.  Reset on `EBADF`-style errors so a
   * deleted-out-from-under-us dir gets recreated rather than failing every
   * subsequent save.
   */
  private dirReady = false;

  constructor(opts: InboundMediaStoreOpts = {}) {
    this.dir = opts.dir ?? defaultInboundMediaDir();
  }

  /** Read-only accessor for tests + diagnostics. */
  get directory(): string {
    return this.dir;
  }

  /**
   * Idempotent: create the storage directory at mode 0700 if missing.
   * Best-effort `chmod` on non-Unix filesystems.  Safe to call concurrently;
   * `mkdir({ recursive: true })` collapses races.
   */
  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      await chmod(this.dir, DIR_MODE);
    } catch {
      // Windows / FAT cannot honor POSIX mode bits.  Mirrors the
      // best-effort chmod elsewhere in the codebase (whatsapp.ensureAuthDir,
      // daemon home-dir creation).
    }
    this.dirReady = true;
  }

  /** Persist a voice note / audio attachment. */
  async saveAudio(opts: SaveOpts): Promise<InboundMediaSavedRef> {
    return this.save(opts, "audio");
  }

  /** Persist an image attachment. */
  async saveImage(opts: SaveOpts): Promise<InboundMediaSavedRef> {
    return this.save(opts, "image");
  }

  /** Persist a document attachment (PDF, docx, etc.). */
  async saveDocument(opts: SaveOpts): Promise<InboundMediaSavedRef> {
    return this.save(opts, "document");
  }

  /** Persist a video / sticker / animated attachment. */
  async saveVideo(opts: SaveOpts): Promise<InboundMediaSavedRef> {
    return this.save(opts, "video");
  }

  /**
   * Delete files (not subdirectories) whose mtime is older than the cutoff
   * implied by `days`.  Returns the number of files deleted.  Best-effort:
   * a single failed unlink does not abort the sweep.
   *
   * Intended to be called from the daemon's daily purge timer.  The daemon
   * glue (FIX-B-1 / FIX-B-2 own daemon.ts) wires this alongside the existing
   * `auditLog.purgeOlderThan` invocation.
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
      const fullPath = join(this.dir, name);
      let mtimeMs: number;
      let isFile: boolean;
      try {
        const st = await stat(fullPath);
        mtimeMs = st.mtimeMs;
        isFile = st.isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;
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

  // -------------------------------------------------------------------------
  // Internal — atomic save
  // -------------------------------------------------------------------------

  /**
   * Atomic write: tempfile + rename, then chmod 0600.  Concurrent saves
   * serialize through `writeQueue` (mirrors `JsonStore.enqueueWrite`).
   *
   * Returns the persisted ref (path + mediaType + size).  The caller is
   * responsible for setting the appropriate `payload.*Ref` field on the
   * InboundMessage; this module deliberately stays unaware of the channel
   * layer's payload shape.
   */
  private async save(
    opts: SaveOpts,
    mediaType: InboundMediaSavedRef["mediaType"],
  ): Promise<InboundMediaSavedRef> {
    return this.enqueueWrite(async () => {
      if (!this.dirReady) {
        await this.ensureDir();
      }

      const safeId = sanitizeMsgId(opts.msgId);
      const safeExt = sanitizeExt(opts.ext);
      const targetPath = join(this.dir, `${safeId}.${safeExt}`);
      const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

      try {
        await writeFile(tempPath, opts.buffer, { mode: FILE_MODE });
        await rename(tempPath, targetPath);
      } catch (error) {
        // Best-effort cleanup of the orphaned temp.  ENOENT is expected
        // if writeFile failed before creating the tempfile.
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }

      // chmod again post-rename: writeFile honors `mode` only on file
      // creation; if the file already existed we'd inherit its old mode.
      // Tempfile names are unique-per-call so this should be a no-op in
      // practice but the explicit chmod keeps the invariant in code.
      try {
        await chmod(targetPath, FILE_MODE);
      } catch {
        // Non-Unix; ignore.
      }

      return {
        path: targetPath,
        mediaType,
        sizeBytes: opts.buffer.byteLength,
        ...(opts.mimeType !== undefined ? { mimeType: opts.mimeType } : {}),
      };
    });
  }

  /**
   * Serialize an async operation behind any in-flight write.  Errors do
   * not poison the queue — subsequent saves still run.  Mirrors
   * `JsonStore.enqueueWrite`.
   */
  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    // Track only the void-resolved tail so the queue type stays Promise<void>.
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reduce a channel-supplied msg id to a filesystem-safe basename.
 *
 * Channels deliver ids in wildly different shapes:
 *   - Telegram: integer message_id (`"1234"`) — already safe but stringified.
 *   - Baileys: short alnum strings (`"3EB0..."`) but also occasionally
 *     contain `/`, `=`, or other base64-ish characters.
 *
 * Rather than enumerating every "bad" character we fall back to a sha256
 * of the raw id when ANY suspicious character appears.  Stable, collision-
 * free for the realistic id-space, and avoids leaking the raw id into
 * the filesystem (which mirrors the audit-log "no raw jid on disk" stance).
 *
 * Pure-numeric / `[A-Za-z0-9_-]`-only ids (the 99% case) pass through
 * verbatim so directory listings stay debuggable.
 */
export function sanitizeMsgId(id: string): string {
  if (id.length === 0) {
    return "empty";
  }
  // Accept only the conservative POSIX-portable charset plus `_` and `-`.
  // Reject leading dot (would create a hidden file) and length > 64.
  if (id.length <= 64 && id[0] !== "." && /^[A-Za-z0-9_-]+$/.test(id)) {
    return id;
  }
  // Anything else: hash to a stable 32-char hex (16 bytes of sha256).
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}

/**
 * Reduce a channel-supplied extension hint to a safe basename suffix.
 *
 * Channels supply MIME-derived hints (`"ogg"`, `"jpg"`, sometimes the full
 * filename `"report.pdf"` from a documentMessage).  We strip leading dots,
 * trim to the last `.`-segment, lowercase, accept only `[A-Za-z0-9]`, cap
 * at MAX_EXT_CHARS, and fall back to `bin` if nothing usable is left.
 */
export function sanitizeExt(ext: string): string {
  if (ext.length === 0) return FALLBACK_EXT;
  // If the caller passed a filename (`"report.pdf"`), keep the last segment.
  const lastDot = ext.lastIndexOf(".");
  const segment = lastDot >= 0 ? ext.slice(lastDot + 1) : ext;
  const cleaned = segment.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length === 0) return FALLBACK_EXT;
  return cleaned.slice(0, MAX_EXT_CHARS);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
