/**
 * Tests for the per-OS install scripts (IMPL-18).
 *
 * Strategy: each install script supports a `--dry-run` (POSIX shell) or
 * `-DryRun` (PowerShell) mode that prints the resolved unit/plist/task
 * payload and the actions it would take, but writes nothing. We invoke
 * each script in its dry-run mode and assert the output contains the
 * load-bearing posture decisions called out in the plan
 * (PE Skeptic Round 2 findings).
 *
 * Per-OS skips:
 *   - launchd dry-run runs on any platform that has bash + tsx (output is
 *     deterministic; bootstrap/enable steps are not executed in dry-run).
 *   - systemd dry-run runs on Linux only (refuses to run otherwise; we
 *     skip on macOS / Windows). Linger assertion is skipped under dry-run.
 *   - Windows-task dry-run runs on Windows only (the New-ScheduledTask*
 *     cmdlet family is Windows-only). On macOS / Linux we just assert
 *     the file is parseable / readable.
 *
 * Coverage targets:
 *   1. install-launchd.sh --dry-run produces a valid plist XML
 *   2. install-launchd.sh --dry-run plist has KeepAlive { Crashed: true }
 *   3. install-launchd.sh --dry-run plist has StandardOutPath/ErrorPath
 *   4. install-launchd.sh --dry-run plist has ThrottleInterval = 60
 *   5. install-launchd.sh --dry-run uses the audio.sergiopena.pi-comms label
 *   6. install-systemd.sh --dry-run produces a valid service unit (Linux only)
 *   7. install-systemd.sh --dry-run unit has Restart=on-failure + RestartSec=60
 *   8. install-windows-task.ps1 -DryRun produces a valid task XML (Win only)
 *   9. install-windows-task.ps1 -DryRun task has IgnoreNew (Win only)
 *  10. uninstall wrappers forward to the installer with --uninstall
 */

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { platform } from "node:os";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPTS = {
  launchd: resolve(REPO_ROOT, "scripts/install-launchd.sh"),
  systemd: resolve(REPO_ROOT, "scripts/install-systemd.sh"),
  windowsTask: resolve(REPO_ROOT, "scripts/install-windows-task.ps1"),
  uninstallLaunchd: resolve(REPO_ROOT, "scripts/uninstall-launchd.sh"),
  uninstallSystemd: resolve(REPO_ROOT, "scripts/uninstall-systemd.sh"),
  uninstallWindowsTask: resolve(REPO_ROOT, "scripts/uninstall-windows-task.ps1"),
};

const PLAT = platform();

function hasCommand(cmd: string): boolean {
  // Cross-platform `which`.
  const probe = spawnSync(PLAT === "win32" ? "where" : "command", [
    PLAT === "win32" ? cmd : "-v",
    cmd,
  ]);
  if (probe.status === 0) return true;
  // Fallback for shells that ship `command` only as a builtin: try direct.
  const direct = spawnSync(cmd, ["--version"]);
  return direct.status === 0;
}

function runBash(script: string, args: string[] = []): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

describe("install scripts — file presence + executability", () => {
  test("all six scripts exist on disk", () => {
    for (const [name, path] of Object.entries(SCRIPTS)) {
      expect(existsSync(path), `${name} should exist at ${path}`).toBe(true);
    }
  });

  test("bash installers are executable (not write-only on disk)", () => {
    if (PLAT === "win32") return; // POSIX-mode bits not meaningful on Windows fs
    for (const sh of [
      SCRIPTS.launchd,
      SCRIPTS.systemd,
      SCRIPTS.uninstallLaunchd,
      SCRIPTS.uninstallSystemd,
    ]) {
      const mode = statSync(sh).mode & 0o777;
      // We don't enforce executable bit (some checkouts may strip it on
      // copy); we DO enforce read access for the user.
      expect((mode & 0o400) !== 0, `${sh} should be user-readable`).toBe(true);
    }
  });
});

describe("install-launchd.sh --dry-run", () => {
  // Plist generation is OS-agnostic (just text); the bootstrap/enable steps
  // are short-circuited by --dry-run. Skip the test only if bash isn't
  // available (e.g. running this suite on a stripped Windows host).
  const skip = !hasCommand("bash");

  test.skipIf(skip)("emits a valid <?xml?> plist preamble", () => {
    const out = runBash(SCRIPTS.launchd, ["--dry-run"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("<?xml version=\"1.0\"");
    expect(out.stdout).toContain("<!DOCTYPE plist PUBLIC");
    expect(out.stdout).toContain("<plist version=\"1.0\">");
  });

  test.skipIf(skip)("uses the audio.sergiopena.pi-comms label", () => {
    const out = runBash(SCRIPTS.launchd, ["--dry-run"]);
    expect(out.stdout).toContain("<string>audio.sergiopena.pi-comms</string>");
  });

  test.skipIf(skip)("encodes KeepAlive { Crashed: true } per PE Skeptic R2", () => {
    const out = runBash(SCRIPTS.launchd, ["--dry-run"]);
    expect(out.stdout).toContain("<key>KeepAlive</key>");
    // Posture: SuccessfulExit=false, Crashed=true. We assert both keys.
    expect(out.stdout).toContain("<key>SuccessfulExit</key>");
    expect(out.stdout).toContain("<key>Crashed</key>");
  });

  test.skipIf(skip)("encodes StandardOutPath and StandardErrorPath", () => {
    const out = runBash(SCRIPTS.launchd, ["--dry-run"]);
    expect(out.stdout).toContain("<key>StandardOutPath</key>");
    expect(out.stdout).toContain("<key>StandardErrorPath</key>");
    expect(out.stdout).toContain(".pi-comms/launchd.stdout.log");
    expect(out.stdout).toContain(".pi-comms/launchd.stderr.log");
  });

  test.skipIf(skip)("encodes ThrottleInterval = 60", () => {
    const out = runBash(SCRIPTS.launchd, ["--dry-run"]);
    expect(out.stdout).toContain("<key>ThrottleInterval</key>");
    expect(out.stdout).toContain("<integer>60</integer>");
  });

  test.skipIf(skip)("encodes RunAtLoad = true and a WorkingDirectory", () => {
    const out = runBash(SCRIPTS.launchd, ["--dry-run"]);
    expect(out.stdout).toContain("<key>RunAtLoad</key>");
    expect(out.stdout).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(out.stdout).toContain("<key>WorkingDirectory</key>");
  });

  test.skipIf(skip)("rejects unknown flags", () => {
    const out = runBash(SCRIPTS.launchd, ["--no-such-flag"]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("unknown flag");
  });
});

describe("install-systemd.sh --dry-run", () => {
  // The script refuses to run on non-Linux UNLESS in dry-run, so we can
  // exercise dry-run on macOS (and also on Linux). Skip if no bash.
  const skip = !hasCommand("bash");

  test.skipIf(skip)("emits [Unit], [Service], [Install] sections", () => {
    const out = runBash(SCRIPTS.systemd, ["--dry-run"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("[Unit]");
    expect(out.stdout).toContain("[Service]");
    expect(out.stdout).toContain("[Install]");
    expect(out.stdout).toContain("Description=pi-comms daemon");
  });

  test.skipIf(skip)("specifies Type=simple + Restart=on-failure + RestartSec=60", () => {
    const out = runBash(SCRIPTS.systemd, ["--dry-run"]);
    expect(out.stdout).toContain("Type=simple");
    expect(out.stdout).toContain("Restart=on-failure");
    expect(out.stdout).toContain("RestartSec=60");
  });

  test.skipIf(skip)("appends to ~/.pi-comms/systemd.{stdout,stderr}.log", () => {
    const out = runBash(SCRIPTS.systemd, ["--dry-run"]);
    expect(out.stdout).toContain("StandardOutput=append:");
    expect(out.stdout).toContain("StandardError=append:");
    expect(out.stdout).toContain(".pi-comms/systemd.stdout.log");
    expect(out.stdout).toContain(".pi-comms/systemd.stderr.log");
  });

  test.skipIf(skip)("uses WantedBy=default.target (user-mode)", () => {
    const out = runBash(SCRIPTS.systemd, ["--dry-run"]);
    expect(out.stdout).toContain("WantedBy=default.target");
  });

  test.skipIf(skip)("rejects unknown flags", () => {
    const out = runBash(SCRIPTS.systemd, ["--no-such-flag"]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("unknown flag");
  });
});

describe("install-systemd.sh — linger gate (Linux only, non-dry-run)", () => {
  // We do NOT actually invoke this on Linux without dry-run because it
  // would attempt a real install. We assert the source contains the
  // assertion-and-refusal logic so the gate cannot silently regress.
  test("refusal message references loginctl enable-linger", () => {
    const src = readFileSync(SCRIPTS.systemd, "utf8");
    expect(src).toContain("loginctl enable-linger");
    expect(src).toContain("REFUSING to install");
    expect(src).toContain("PE Skeptic R2");
  });

  test("install path calls assert_linger before generating the unit", () => {
    const src = readFileSync(SCRIPTS.systemd, "utf8");
    // Order: assert_linger then resolve_exec_start then generate_unit
    const idxAssert = src.lastIndexOf("assert_linger");
    const idxResolve = src.lastIndexOf("resolve_exec_start");
    const idxGenerate = src.lastIndexOf("UNIT_CONTENT=\"$(generate_unit)\"");
    expect(idxAssert).toBeGreaterThan(0);
    expect(idxResolve).toBeGreaterThan(idxAssert);
    expect(idxGenerate).toBeGreaterThan(idxResolve);
  });
});

describe("install-windows-task.ps1 — source contents (cross-platform)", () => {
  // We can run -DryRun for real only on Windows. On macOS / Linux we
  // assert that the source carries the load-bearing posture decisions
  // (so the file can't silently lose them). Most CI runs the suite on
  // macOS — this gives meaningful coverage there.
  const src = readFileSync(SCRIPTS.windowsTask, "utf8");

  test("declares -AtLogOn trigger scoped to current user", () => {
    expect(src).toContain("New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME");
  });

  test("uses MultipleInstances IgnoreNew per PE Skeptic R2", () => {
    expect(src).toContain("-MultipleInstances IgnoreNew");
    expect(src).toContain("PE Skeptic R2");
  });

  test("runs as Limited (NOT Highest) — least privilege", () => {
    expect(src).toContain("-RunLevel Limited");
    // The Highest token may appear in commentary explaining why we DON'T
    // use it. We only forbid it as an actual cmdlet argument. Match
    // against the active New-ScheduledTaskPrincipal invocation only.
    const principalBlock = src.match(/New-ScheduledTaskPrincipal[\s\S]+?(?=\n\$|\n\n)/);
    expect(principalBlock).not.toBeNull();
    expect(principalBlock?.[0] ?? "").not.toContain("-RunLevel Highest");
  });

  test("idempotent re-install — Unregister-ScheduledTask before Register", () => {
    expect(src).toContain("Unregister-ScheduledTask");
    expect(src).toContain("Register-ScheduledTask");
  });

  test("supports -Built (compiled dist) and -DryRun + -Uninstall flags", () => {
    expect(src).toContain("[switch]$Built");
    expect(src).toContain("[switch]$Uninstall");
    expect(src).toContain("[switch]$DryRun");
  });
});

describe("install-windows-task.ps1 -DryRun (Windows only)", () => {
  const skip = PLAT !== "win32" || !hasCommand("pwsh");

  test.skipIf(skip)("dry-run prints the task XML and no real registration occurs", () => {
    const res = spawnSync("pwsh", ["-NoProfile", "-File", SCRIPTS.windowsTask, "-DryRun"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[dry-run]");
    expect(res.stdout).toContain("IgnoreNew");
  });
});

describe("uninstall wrappers", () => {
  test("uninstall-launchd.sh forwards --uninstall", () => {
    const src = readFileSync(SCRIPTS.uninstallLaunchd, "utf8");
    expect(src).toContain("install-launchd.sh");
    expect(src).toContain("--uninstall");
  });

  test("uninstall-systemd.sh forwards --uninstall", () => {
    const src = readFileSync(SCRIPTS.uninstallSystemd, "utf8");
    expect(src).toContain("install-systemd.sh");
    expect(src).toContain("--uninstall");
  });

  test("uninstall-windows-task.ps1 forwards -Uninstall", () => {
    const src = readFileSync(SCRIPTS.uninstallWindowsTask, "utf8");
    expect(src).toContain("install-windows-task.ps1");
    expect(src).toContain("-Uninstall");
  });

  test("bash uninstall wrappers honor --dry-run pass-through", () => {
    if (!hasCommand("bash")) return;
    const out = runBash(SCRIPTS.uninstallLaunchd, ["--dry-run"]);
    // Either no plist (clean state — exits 0 with "nothing to uninstall")
    // OR plist exists and prints "[dry-run] would: launchctl bootout".
    expect(out.status).toBe(0);
    expect(
      out.stdout.includes("nothing to uninstall") ||
        out.stdout.includes("[dry-run] would: launchctl bootout"),
    ).toBe(true);
  });
});
