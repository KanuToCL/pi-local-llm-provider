/**
 * Generic atomic-write JSON file store with corrupt-file quarantine.
 *
 * Pattern lifted from gemini-claw's `JsonSessionStore`
 * (~/Desktop/Cosas/personal/gemini-claw/src/storage/JsonSessionStore.ts:1-105).
 *
 * Adapted to be generic over the stored payload `T`. The store does NOT
 * validate `T` itself — consumers (status pointer, sandbox state, task state)
 * bring their own zod schemas and validate the result of `read<T>()` before
 * trusting it. Corrupt JSON (parse error) is quarantined; type-shape errors
 * are the consumer's responsibility.
 *
 * Guarantees:
 *   - Write is atomic: tempfile + rename. A crash mid-write leaves the
 *     prior committed file intact (or no file at all).
 *   - Concurrent writes through the same instance are serialized via a
 *     per-instance promise queue (no torn writes within one process).
 *   - On JSON parse failure, the offending file is renamed to
 *     `<path>.corrupt-<unix_ms>.bak` and `read()` returns `null`.
 *   - Missing file → `read()` returns `null` (not an error).
 *
 * Limitations:
 *   - Cross-process serialization is the OS rename atomicity guarantee.
 *     Two daemons writing simultaneously will produce a last-writer-wins
 *     outcome (which is fine — there should only be one daemon).
 *   - The store does NOT fsync the directory entry. POSIX rename is
 *     atomic for the inode swap; durability semantics inherit from the
 *     underlying filesystem.
 */

import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export class JsonStore<T> {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  /** Path of the underlying file (read-only accessor for tests/diagnostics). */
  get filePath(): string {
    return this.path;
  }

  /**
   * Read and JSON-parse the file. Returns `null` if the file is missing.
   * If JSON parsing fails, the file is quarantined and `null` is returned.
   * The caller is responsible for validating the shape of the returned value
   * (typically via a zod schema).
   */
  async read(): Promise<T | null> {
    // Wait for any in-flight write to finish before reading.
    await this.writeQueue;

    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        await this.quarantine();
        return null;
      }
      throw error;
    }
  }

  /**
   * Write `data` to the file atomically. Concurrent writes through the
   * same instance are serialized — this method returns the promise for
   * the queued write, so awaiting it guarantees the data is on disk
   * (modulo OS write-back caches).
   *
   * If the temp-file write fails, the temp file is unlinked and the
   * existing committed file is left untouched.
   */
  async write(data: T): Promise<void> {
    return this.enqueueWrite(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        await rename(tempPath, this.path);
      } catch (error) {
        // Best-effort cleanup of the orphaned temp file. If it never
        // got created (writeFile threw), unlink will ENOENT — swallow.
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Move the current file aside to `<path>.corrupt-<unix_ms>.bak`.
   * No-op if the file is missing. Public so consumers can quarantine
   * after their own validator (e.g. a zod schema) rejects the parsed
   * payload — `read()` only quarantines on parse failure.
   */
  async quarantine(): Promise<void> {
    const quarantinePath = `${this.path}.corrupt-${Date.now()}.bak`;
    try {
      await rename(this.path, quarantinePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  /**
   * Serialize an async operation behind any in-flight write. Errors do
   * not poison the queue — subsequent writes still run.
   */
  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
