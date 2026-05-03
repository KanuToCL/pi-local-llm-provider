/**
 * Single-instance lock for the pi-comms daemon.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - Pitfall #11: "Daemon double-start. PID file or OS-native mutex."
 *
 * Design:
 *   - Uses POSIX exclusive-create open (`fs.open(path, 'wx')`) to atomically
 *     create the lockfile. If the file already exists, `wx` fails with
 *     EEXIST — no race window between "check if file exists" and "create
 *     file". Two daemons booting simultaneously cannot both succeed.
 *   - Writes the current process PID to the lockfile so a stale lockfile
 *     left behind by a crashed daemon can be reaped on the next boot.
 *   - On stale-lockfile detection (PID in file is no longer alive — we use
 *     `process.kill(pid, 0)` which throws ESRCH for dead PIDs), the lockfile
 *     is unlinked and the boot retries the exclusive-create exactly once.
 *     A second EEXIST after the reap means a real concurrent daemon raced
 *     us — we refuse with a structured error.
 *   - On Windows, `fs.open(path, 'wx')` has the same semantics (returns
 *     EEXIST when the file is present), and `process.kill(pid, 0)` is
 *     supported as a liveness probe — the same code path works without
 *     a separate Windows branch.
 *
 * Lifecycle:
 *   - `acquireLock(lockPath)` returns `{ release }`. Call `release()` from
 *     the daemon shutdown handler to unlink the lockfile. `release()` is
 *     idempotent — calling it twice is safe.
 *   - The lockfile is NOT auto-released on process death; that's why the
 *     stale-PID reaping is part of the boot path. A daemon that crashes
 *     before calling `release()` leaves a lockfile, but the next boot
 *     reaps it via the liveness check.
 */

import { open, readFile, unlink } from "node:fs/promises";

/**
 * Thrown when another live daemon already holds the lock. Callers should
 * surface this as a clean boot-refused message — `error.pid` is the rival
 * daemon's PID, useful for the operator's diagnostic output.
 */
export class SingleInstanceLockError extends Error {
  /** PID of the other daemon that holds the lock. */
  readonly pid: number;

  constructor(pid: number, message?: string) {
    super(
      message ??
        `another daemon (pid=${pid}) already running — refusing to start`,
    );
    this.name = "SingleInstanceLockError";
    this.pid = pid;
  }
}

/**
 * Handle returned by `acquireLock`. `release()` unlinks the lockfile;
 * idempotent (subsequent calls are no-ops).
 */
export interface SingleInstanceLockHandle {
  release(): Promise<void>;
}

/**
 * Test seam: an injectable PID-liveness probe. Production passes
 * `process.kill(pid, 0)`; tests pass a controllable function. Returns
 * `true` if the PID is alive, `false` if not.
 */
export interface AcquireLockOpts {
  /**
   * Function to test whether `pid` is alive. Defaults to using
   * `process.kill(pid, 0)` (which throws ESRCH if the PID is dead and
   * returns void if alive). Tests can inject a fake to simulate either
   * outcome deterministically.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Function returning the current process PID written into the lockfile.
   * Defaults to `process.pid`. Tests inject a stable value.
   */
  selfPid?: () => number;
}

/**
 * Acquire the single-instance lock. Reaps stale lockfiles (created by a
 * crashed prior daemon whose PID is no longer alive) before refusing.
 *
 * Boot sequence — call this very early, BEFORE any IPC server bind / FS
 * mutation that two daemons would race on. Returns `{ release }`; the
 * caller MUST await `release()` from the daemon shutdown handler so the
 * lockfile is removed cleanly on graceful exit.
 *
 * Throws `SingleInstanceLockError` if a live daemon already holds the lock.
 * Other errors (EACCES, ENOSPC, etc.) propagate untouched — the caller
 * should treat them as boot failures.
 */
export async function acquireLock(
  lockPath: string,
  opts: AcquireLockOpts = {},
): Promise<SingleInstanceLockHandle> {
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const selfPid = opts.selfPid ?? (() => process.pid);

  // First attempt — exclusive-create.
  try {
    await writeLock(lockPath, selfPid());
    return makeHandle(lockPath);
  } catch (err) {
    if (!isEexist(err)) throw err;
  }

  // Lockfile exists — read the PID and probe liveness.
  let priorPid: number;
  try {
    const raw = await readFile(lockPath, "utf8");
    priorPid = parseLockPid(raw);
  } catch (err) {
    // Lockfile vanished between our open and read — race; retry once.
    if (isEnoent(err)) {
      try {
        await writeLock(lockPath, selfPid());
        return makeHandle(lockPath);
      } catch (err2) {
        if (isEexist(err2)) {
          // Another daemon raced us in the gap. Best-effort: read its PID.
          const pid = await readLockPidBestEffort(lockPath);
          throw new SingleInstanceLockError(pid);
        }
        throw err2;
      }
    }
    throw err;
  }

  // PID 0 = unparseable lockfile (corrupt/garbage); treat as stale and
  // reap.  If the recorded PID matches ours, that's also a stale-self
  // case — PID reuse after a crash before release().
  const ourPid = selfPid();
  if (priorPid === 0 || priorPid === ourPid || !isPidAlive(priorPid)) {
    // Stale — reap and retry exclusive-create exactly once.
    try {
      await unlink(lockPath);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    try {
      await writeLock(lockPath, selfPid());
      return makeHandle(lockPath);
    } catch (err) {
      if (isEexist(err)) {
        // Another daemon won the race after we reaped. Refuse.
        const pid = await readLockPidBestEffort(lockPath);
        throw new SingleInstanceLockError(pid);
      }
      throw err;
    }
  }

  // Live PID — refuse.
  throw new SingleInstanceLockError(priorPid);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function writeLock(lockPath: string, pid: number): Promise<void> {
  // 'wx' = open for exclusive create. Throws EEXIST if the file already
  // exists — atomic on POSIX and Windows.
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(`${pid}\n`, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function makeHandle(lockPath: string): SingleInstanceLockHandle {
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await unlink(lockPath);
      } catch (err) {
        // ENOENT is fine — the lockfile is already gone (likely because
        // another tool reaped it or `release()` got called twice in
        // parallel). Any other error propagates so the caller can log.
        if (!isEnoent(err)) throw err;
      }
    },
  };
}

function defaultIsPidAlive(pid: number): boolean {
  // process.kill with signal 0 is a liveness probe per POSIX.  Returns
  // void if the process exists (and we have permission to signal it),
  // throws ESRCH if it does not.  Permission errors (EPERM) mean the PID
  // exists but we can't signal it — also "alive" for our purposes.
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (!(err instanceof Error)) return true;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM, EACCES, etc. — the process exists but we can't signal it.
    return true;
  }
}

function parseLockPid(raw: string): number {
  const trimmed = raw.trim();
  const n = Number(trimmed);
  // A non-numeric or NaN lockfile is treated as "stale, reap it".  We
  // return 0 which will fail isPidAlive() (PID 0 is never a real
  // userspace process on Unix, and process.kill(0, 0) signals the
  // current process group — an outcome we never want to interpret as
  // "another daemon is live").
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return 0;
  return n;
}

async function readLockPidBestEffort(lockPath: string): Promise<number> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return parseLockPid(raw);
  } catch {
    return 0;
  }
}

function isEexist(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
