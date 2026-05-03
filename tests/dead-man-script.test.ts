/**
 * Tests for `scripts/dead-man.sh` (and friends). Bash-script tests run
 * via `bash -n` for syntax + hermetic invocations with PATH-prefixed
 * fake `curl` so we can intercept HTTP without touching the network.
 *
 * Coverage targets (per IMPL-19 brief, ≥4 cases):
 *   1. dead-man.sh syntax check passes (`bash -n`).
 *   2. install-deadman-cron.sh syntax check passes.
 *   3. Stale heartbeat → script invokes the configured transport.
 *   4. Fresh heartbeat → script does NOTHING (no notification, no log
 *      noise about notifying).
 *   5. Notification suppression: two stale invocations within 30 min →
 *      only the first notifies.
 *   6. Suppression timer resets when heartbeat recovers between calls.
 *   7. Missing heartbeat file is treated as stale (notifies on first run).
 *
 * Hermetic strategy:
 *   - Each test creates a tempdir as PI_COMMS_HOME.
 *   - We write a stub `curl` script into a tempdir-specific BIN dir and
 *     prepend that to PATH. The stub appends its argv to a transcript
 *     file the test then asserts against.
 *   - Heartbeat mtime is controlled by `touch -d <iso>` (Linux) or
 *     `touch -t <stamp>` (BSD/macOS) — both forms are tried.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Resolve repo paths once.
const REPO_ROOT = resolve(__dirname, "..");
const DEAD_MAN_SH = join(REPO_ROOT, "scripts", "dead-man.sh");
const INSTALL_CRON_SH = join(REPO_ROOT, "scripts", "install-deadman-cron.sh");

let workDir: string;
let homeDir: string; // PI_COMMS_HOME
let binDir: string; // contains stub `curl`
let transcript: string; // stub curl writes here

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-deadman-"));
  homeDir = join(workDir, "home");
  binDir = join(workDir, "bin");
  transcript = join(workDir, "curl-transcript.txt");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Stub curl: append every invocation's argv (one line per call) to the
  // transcript and exit 0. This lets us assert "notifications attempted"
  // without touching the network. The stub is opaque — it does not
  // distinguish ntfy / pushover / mailgun — that distinction is the
  // dead-man script's job.
  const curlStub = `#!/usr/bin/env bash
echo "$@" >> "${transcript}"
exit 0
`;
  const curlStubPath = join(binDir, "curl");
  writeFileSync(curlStubPath, curlStub, "utf8");
  chmodSync(curlStubPath, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function setHeartbeatMtime(absSecondsAgo: number): void {
  const heartbeatPath = join(homeDir, "daemon.heartbeat");
  writeFileSync(heartbeatPath, `${new Date().toISOString()}\n`, "utf8");
  // Use perl for portable mtime-set; works on macOS, Linux, BSD without
  // depending on `touch -d`/`touch -t` flag dialect differences.
  const targetEpoch = Math.floor(Date.now() / 1000) - absSecondsAgo;
  execFileSync("perl", [
    "-e",
    `utime ${targetEpoch}, ${targetEpoch}, "${heartbeatPath}"`,
  ]);
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runDeadMan(extraEnv: Record<string, string> = {}): RunResult {
  // PATH = our bin dir (with stubbed curl) PREFIXED so it shadows any
  // real curl. We KEEP the original PATH after our prefix so `bash`,
  // `date`, `stat`, `hostname`, etc. resolve normally.
  const origPath = process.env.PATH ?? "";
  const result = spawnSync(
    "bash",
    [DEAD_MAN_SH],
    {
      env: {
        // Start clean — explicitly DO NOT inherit notification env so
        // tests can't accidentally pick up the dev's real ntfy topic.
        PATH: `${binDir}:${origPath}`,
        HOME: homeDir,
        PI_COMMS_HOME: homeDir,
        PI_COMMS_DEADMAN_TRANSPORT: "ntfy",
        PI_COMMS_DEADMAN_NTFY_TOPIC: "pi-comms-test-topic",
        PI_COMMS_DEADMAN_NTFY_HOST: "https://ntfy.example.invalid",
        ...extraEnv,
      },
      encoding: "utf8",
    }
  );
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function transcriptLines(): string[] {
  if (!existsSync(transcript)) return [];
  return readFileSync(transcript, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("dead-man.sh — syntax", () => {
  test("dead-man.sh passes `bash -n`", () => {
    const r = spawnSync("bash", ["-n", DEAD_MAN_SH], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("install-deadman-cron.sh passes `bash -n`", () => {
    const r = spawnSync("bash", ["-n", INSTALL_CRON_SH], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});

describe("dead-man.sh — runtime behavior", () => {
  test("stale heartbeat → script invokes curl (notification attempted)", () => {
    setHeartbeatMtime(600); // 10 min ago > 3 min stale threshold
    const r = runDeadMan();
    expect(r.exitCode).toBe(0);
    const calls = transcriptLines();
    expect(calls.length).toBeGreaterThan(0);
    // The stub's only argv is the curl args; verify our ntfy URL appears.
    expect(calls.join("\n")).toContain("ntfy.example.invalid/pi-comms-test-topic");
  });

  test("fresh heartbeat → script does NOTHING (no curl call, exit 0)", () => {
    setHeartbeatMtime(30); // 30s ago, well within 3-min threshold
    const r = runDeadMan();
    expect(r.exitCode).toBe(0);
    expect(transcriptLines()).toEqual([]);
  });

  test("missing heartbeat file → treated as stale, notifies on first run", () => {
    // Don't create a heartbeat at all.
    const r = runDeadMan();
    expect(r.exitCode).toBe(0);
    expect(transcriptLines().length).toBeGreaterThan(0);
  });

  test("notification suppression — two stale invocations within suppress window → only first notifies", () => {
    setHeartbeatMtime(600);
    const r1 = runDeadMan();
    expect(r1.exitCode).toBe(0);
    const callsAfter1 = transcriptLines().length;
    expect(callsAfter1).toBeGreaterThan(0);

    // Second call immediately after — suppressed.
    const r2 = runDeadMan();
    expect(r2.exitCode).toBe(0);
    const callsAfter2 = transcriptLines().length;
    expect(callsAfter2).toBe(callsAfter1); // no new curl invocation
    expect(r2.stdout + r2.stderr).toMatch(/suppressed/);
  });

  test("recovery clears suppression — fresh heartbeat then stale again notifies anew", () => {
    // Stale → notify (first time).
    setHeartbeatMtime(600);
    runDeadMan();
    const callsBefore = transcriptLines().length;

    // Heartbeat recovers.
    setHeartbeatMtime(10);
    const recoveryRun = runDeadMan();
    expect(recoveryRun.exitCode).toBe(0);
    // No new curl call during recovery, but suppression marker should be wiped.
    expect(transcriptLines().length).toBe(callsBefore);

    // Goes stale again.
    setHeartbeatMtime(600);
    runDeadMan();
    expect(transcriptLines().length).toBeGreaterThan(callsBefore);
  });

  test("--print on installer (sanity that flag handling works)", () => {
    const r = spawnSync("bash", [INSTALL_CRON_SH, "--print"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dead-man.sh");
    expect(r.stdout).toContain("*/5 * * * *");
  });
});
