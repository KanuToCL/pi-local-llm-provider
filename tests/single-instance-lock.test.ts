/**
 * Tests for `src/lib/single-instance-lock.ts` (Pitfall #11 — daemon
 * double-start protection).
 *
 * Coverage:
 *   1. acquireLock() succeeds on a fresh path; release() removes the file
 *   2. Concurrent acquireLock() against a live daemon throws SingleInstanceLockError
 *   3. Stale lockfile (PID dead) is reaped and acquireLock() succeeds
 *   4. Lockfile contains caller PID
 *   5. release() is idempotent (second call is no-op)
 *   6. Non-numeric / corrupt lockfile is treated as stale + reaped
 *   7. ESRCH from process.kill(pid, 0) treated as "dead" (production probe)
 *   8. Self-PID lockfile is reaped (defensive — handles same-PID restart)
 *   9. Live process kept alive across acquireLock returns SingleInstanceLockError
 *      with the correct rival PID
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  SingleInstanceLockError,
} from "../src/lib/single-instance-lock.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-lock-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("acquireLock — fresh acquisition", () => {
  test("creates the lockfile and writes the caller PID", async () => {
    const lockPath = join(workDir, "daemon.lock");
    const handle = await acquireLock(lockPath, {
      selfPid: () => 12345,
      isPidAlive: () => false,
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("12345");

    await handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("release() is idempotent", async () => {
    const lockPath = join(workDir, "daemon.lock");
    const handle = await acquireLock(lockPath, {
      selfPid: () => 11111,
      isPidAlive: () => false,
    });
    await handle.release();
    // Second release should not throw.
    await expect(handle.release()).resolves.toBeUndefined();
  });
});

describe("acquireLock — concurrent live daemon", () => {
  test("throws SingleInstanceLockError with rival PID", async () => {
    const lockPath = join(workDir, "daemon.lock");
    // Pre-create the lockfile with a "live" PID.
    writeFileSync(lockPath, "9999\n", "utf8");

    await expect(
      acquireLock(lockPath, {
        selfPid: () => 22222,
        // Anything other than 9999 is "dead"; 9999 is "alive".
        isPidAlive: (pid) => pid === 9999,
      }),
    ).rejects.toMatchObject({
      name: "SingleInstanceLockError",
      pid: 9999,
    });

    // Lockfile must be left intact.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("9999");
  });

  test("SingleInstanceLockError carries the rival PID", async () => {
    const lockPath = join(workDir, "daemon.lock");
    writeFileSync(lockPath, "31415\n", "utf8");
    try {
      await acquireLock(lockPath, {
        selfPid: () => 99999,
        isPidAlive: () => true,
      });
      throw new Error("expected SingleInstanceLockError");
    } catch (err) {
      expect(err).toBeInstanceOf(SingleInstanceLockError);
      expect((err as SingleInstanceLockError).pid).toBe(31415);
    }
  });
});

describe("acquireLock — stale lockfile reaping", () => {
  test("dead-PID lockfile is reaped and acquireLock succeeds", async () => {
    const lockPath = join(workDir, "daemon.lock");
    // Pre-create the lockfile with a "dead" PID.
    writeFileSync(lockPath, "8888\n", "utf8");

    const handle = await acquireLock(lockPath, {
      selfPid: () => 22222,
      // Always dead.
      isPidAlive: () => false,
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe("22222");

    await handle.release();
  });

  test("non-numeric lockfile is treated as stale and reaped", async () => {
    const lockPath = join(workDir, "daemon.lock");
    writeFileSync(lockPath, "garbage-nonsense\n", "utf8");

    const handle = await acquireLock(lockPath, {
      selfPid: () => 44444,
      // Even though our injected probe would say "alive", the parsed PID
      // is 0 which is treated as stale regardless.
      isPidAlive: () => true,
    });

    expect(readFileSync(lockPath, "utf8").trim()).toBe("44444");
    await handle.release();
  });

  test("lockfile holding our own PID is reaped (defensive)", async () => {
    const lockPath = join(workDir, "daemon.lock");
    writeFileSync(lockPath, "55555\n", "utf8");
    const handle = await acquireLock(lockPath, {
      selfPid: () => 55555,
      // Self is alive (this process is alive), but the same-PID case is
      // treated as stale to defend against PID-reuse after a crash.
      isPidAlive: () => true,
    });
    expect(readFileSync(lockPath, "utf8").trim()).toBe("55555");
    await handle.release();
  });
});

describe("acquireLock — production-shaped probe", () => {
  test("default isPidAlive uses process.kill(pid, 0); detects dead PID", async () => {
    const lockPath = join(workDir, "daemon.lock");
    // PID 1 (init) is virtually always alive on Unix; on Windows the
    // 4 process is the system process.  For a robust dead-PID test we
    // pick a deliberately impossible PID — 2_147_483_646 is at the int
    // boundary and very unlikely to be live anywhere.
    const deadPid = 2_147_483_646;
    writeFileSync(lockPath, `${deadPid}\n`, "utf8");

    // Use the production isPidAlive (default).  If the OS happens to
    // have a process at that PID, the test would degrade gracefully —
    // but in practice this PID is unused.
    const handle = await acquireLock(lockPath, { selfPid: () => 23456 });
    expect(readFileSync(lockPath, "utf8").trim()).toBe("23456");
    await handle.release();
  });
});
