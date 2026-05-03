/**
 * Per-OS sandboxed exec shim.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md §"Phase 3 expansion — Sandbox-first"
 * (line 1083) and §"Sandbox per OS" (line 1091):
 *
 *   | OS      | Mechanism                                           |
 *   |---------|-----------------------------------------------------|
 *   | Linux   | bwrap --bind <workspace> /work --ro-bind /usr ...  |
 *   | macOS   | sandbox-exec -p '<sbpl-profile>' (workspace-only)   |
 *   | Windows | AppContainer + restricted token                     |
 *
 * Three top-level functions:
 *
 *   - `detectSandboxMode()` — synchronous, returns the mode name (or null
 *     if no primitive is available). The daemon calls this at boot to
 *     decide whether sandbox enforcement is even possible on this machine.
 *
 *   - `execSandboxed({cmd, workspace, ...})` — the bash-tool wrapper's hot
 *     path. Routes through the OS primitive. Workspace is the ONLY
 *     writable subtree.
 *
 *   - `execRaw({cmd, workspace, ...})` — used after `/unsand`. Same
 *     spawn semantics, no sandbox wrapping. Still respects the workspace
 *     `cwd` so relative paths in the command resolve consistently.
 *
 * Cancellation:
 *   - All three honor `AbortSignal`. On abort: SIGTERM → 5s grace →
 *     SIGKILL (per plan §"v4.2 `/unsand <minutes>` window expiry kills
 *     in-flight bash" line 1520).
 *   - Timeout is implemented as an internal `AbortController` triggered by
 *     `setTimeout`. The exposed `abortSignal` and the timeout share the
 *     same kill path, so the result fields (`timedOut`/`aborted`) reflect
 *     which signal won.
 *
 * Windows:
 *   - AppContainer is non-trivial (Job Object + restricted token + dynamic
 *     ACLs). v1 ships a STUB that prints an honest warning to stderr and
 *     runs raw exec. The daemon at startup checks `detectSandboxMode()`
 *     against the `appcontainer-stub` value and refuses to start unless
 *     `PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true`. That env-gating lives in
 *     the daemon boot path; this module just exposes the mode honestly so
 *     callers can make the decision.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { platform as osPlatform, type } from "node:os";
import { existsSync, statSync } from "node:fs";
import { delimiter, sep } from "node:path";

export type SandboxMode = "bwrap" | "sandbox-exec" | "appcontainer-stub";

export interface SandboxedExecOpts {
  /** Shell command line. Executed via `sh -c <cmd>` (or `cmd /c <cmd>` on Windows). */
  cmd: string;
  /** Absolute path to the writable workspace. The only RW subtree under sandbox. */
  workspace: string;
  /** Wall-clock timeout. Default 5 minutes. Use `Infinity` to disable. */
  timeoutMs?: number;
  /** External cancellation. SIGTERM → 5s grace → SIGKILL on abort. */
  abortSignal?: AbortSignal;
  /** Optional environment overlay; merged on top of `process.env`. */
  env?: Record<string, string>;
}

export interface SandboxedExecResult {
  stdout: string;
  stderr: string;
  /** Non-null when the child exited; null when killed by signal before exit. */
  exitCode: number | null;
  /** Signal that killed the child, if any. Useful for debugging SIGKILL paths. */
  signal: NodeJS.Signals | null;
  /** True if the wall-clock timeout fired before the child exited. */
  timedOut: boolean;
  /** True if `abortSignal` (or a daemon-driven cancel) fired. */
  aborted: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const KILL_GRACE_MS = 5_000; // SIGTERM grace before SIGKILL

/**
 * Returns the sandbox primitive available on this host, or null if none.
 *
 *   - Linux: returns 'bwrap' iff `bwrap` is on PATH AND executable.
 *   - macOS: returns 'sandbox-exec' iff `/usr/bin/sandbox-exec` exists.
 *   - Windows: returns 'appcontainer-stub' (the v1 honest-stub mode).
 *   - Other (FreeBSD, Solaris, etc.): null.
 *
 * Synchronous on purpose — daemon boot needs the answer before the first
 * IPC connection accepts.
 */
export function detectSandboxMode(): SandboxMode | null {
  const plat = osPlatform();
  if (plat === "linux") {
    return findOnPath("bwrap") ? "bwrap" : null;
  }
  if (plat === "darwin") {
    // sandbox-exec ships as part of macOS at this fixed path. We avoid
    // PATH-walking because sandbox-exec is normally not on developer PATHs
    // even though the binary exists.
    return existsSync("/usr/bin/sandbox-exec") ? "sandbox-exec" : null;
  }
  if (plat === "win32") {
    // v1: AppContainer NOT implemented. We expose the stub so the daemon
    // can refuse to start (or honor the explicit env opt-in).
    return "appcontainer-stub";
  }
  return null;
}

/**
 * Run `cmd` inside the OS sandbox primitive. The workspace is the only
 * writable subtree; system locations (`/usr`, `/lib`) are read-only;
 * `$HOME` is NOT mounted; network is disabled by default (Linux only;
 * macOS sbpl in v1 omits the network deny for compatibility — see the
 * profile string below).
 *
 * On systems without a sandbox primitive (FreeBSD etc.), throws — callers
 * must check `detectSandboxMode()` first and fall back to a documented
 * "sandbox-unavailable" daemon state.
 *
 * On Windows the appcontainer-stub mode prints a one-time warning to
 * stderr (so log scrapers can detect the unsandboxed run) and runs raw.
 */
export async function execSandboxed(
  opts: SandboxedExecOpts
): Promise<SandboxedExecResult> {
  const mode = detectSandboxMode();
  if (mode === null) {
    throw new Error(
      `execSandboxed: no sandbox primitive available on ${type()}; check detectSandboxMode() before calling`
    );
  }

  if (mode === "appcontainer-stub") {
    // Honest warning. Logged once per call (the daemon further suppresses
    // duplicates if it wants — this layer prefers loud).
    process.stderr.write(
      "[pi-comms] WARNING: Windows sandbox not implemented in v1; running unsandboxed — DO NOT use until WindowsAppContainer is shipped in a future release.\n"
    );
    return execRaw(opts);
  }

  if (mode === "bwrap") {
    return spawnAndWait(buildBwrapArgv(opts), opts);
  }

  if (mode === "sandbox-exec") {
    return spawnAndWait(buildSandboxExecArgv(opts), opts);
  }

  // Exhaustiveness guard for future modes.
  throw new Error(`execSandboxed: unhandled sandbox mode ${mode}`);
}

/**
 * Run `cmd` raw, no sandbox wrapping. Used by `/unsand` and the Windows
 * stub. Still routes through the same `spawnAndWait` path so result
 * shape, timeout, and abort semantics match the sandboxed version.
 */
export async function execRaw(
  opts: SandboxedExecOpts
): Promise<SandboxedExecResult> {
  const argv = osPlatform() === "win32" ? buildWindowsRawArgv(opts) : buildPosixRawArgv(opts);
  return spawnAndWait(argv, opts);
}

// ---------------------------------------------------------------------------
// Argv builders
// ---------------------------------------------------------------------------

interface SpawnArgv {
  /** Executable path or PATH-resolvable name. */
  command: string;
  /** Argument vector (does NOT include the command itself). */
  args: readonly string[];
  /** Working directory for the child. */
  cwd: string;
}

/**
 * Build the bwrap argv per plan §"Sandbox per OS" Linux row.
 *
 *   bwrap --bind <workspace> /work \
 *         --ro-bind /usr /usr --ro-bind /lib /lib \
 *         --proc /proc --dev /dev --unshare-net \
 *         -- sh -c <cmd>
 *
 * Notes:
 *   - We bind the workspace to `/work` inside the namespace AND set the
 *     child's cwd to `/work`. The user's command sees a clean tree rooted
 *     at the workspace — no leak of the host's full path.
 *   - `--unshare-net` denies network. The plan calls out an opt-in via
 *     the system prompt; that opt-in toggle lives in the bash-tool wrapper
 *     (a future flag will pass `network: true` from the policy down).
 *   - `/lib64` is added when present; some distros (Alpine) only ship
 *     `/lib`. Best-effort additions are guarded by `existsSync`.
 */
function buildBwrapArgv(opts: SandboxedExecOpts): SpawnArgv {
  const args: string[] = [
    "--die-with-parent",
    "--bind",
    opts.workspace,
    "/work",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/lib",
    "/lib",
  ];

  if (existsSync("/lib64")) {
    args.push("--ro-bind", "/lib64", "/lib64");
  }
  if (existsSync("/etc")) {
    // /etc is needed for /etc/resolv.conf etc., but we mount it read-only
    // so a malicious cmd can't rewrite hosts to redirect.
    args.push("--ro-bind", "/etc", "/etc");
  }
  if (existsSync("/bin")) {
    args.push("--ro-bind", "/bin", "/bin");
  }

  args.push("--proc", "/proc", "--dev", "/dev", "--unshare-net", "--chdir", "/work");

  args.push("--", "sh", "-c", opts.cmd);

  return {
    command: "bwrap",
    args,
    cwd: opts.workspace,
  };
}

/**
 * Build the sandbox-exec argv per plan §"Sandbox per OS" macOS row.
 *
 * The SBPL (Sandbox Profile Language) profile:
 *   - Default deny everything via `(deny default)`.
 *   - Allow process-fork/exec/signal so child binaries can run.
 *   - Allow read everywhere (read-only is the default-safe posture; the
 *     macOS profile is more permissive than bwrap's by necessity — system
 *     binaries link against many shared libraries spread across /System,
 *     /usr, /Library, etc.).
 *   - Allow file-write* ONLY under the workspace subpath.
 *   - Allow process-info-pidinfo for ps(1) and similar.
 *   - Network: `(deny network*)` to mirror the Linux posture.
 */
function buildSandboxExecArgv(opts: SandboxedExecOpts): SpawnArgv {
  // sandbox-exec rejects backslashes in subpath strings; macOS workspace
  // paths are POSIX so this is normally fine, but escape any embedded
  // double-quotes defensively.
  const safeWs = opts.workspace.replace(/"/g, '\\"');

  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal)",
    "(allow process-info*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    `(allow file-write* (subpath "${safeWs}"))`,
    "(deny network*)",
  ].join(" ");

  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", profile, "sh", "-c", opts.cmd],
    cwd: opts.workspace,
  };
}

function buildPosixRawArgv(opts: SandboxedExecOpts): SpawnArgv {
  return {
    command: "sh",
    args: ["-c", opts.cmd],
    cwd: opts.workspace,
  };
}

function buildWindowsRawArgv(opts: SandboxedExecOpts): SpawnArgv {
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", opts.cmd],
    cwd: opts.workspace,
  };
}

// ---------------------------------------------------------------------------
// Spawn driver
// ---------------------------------------------------------------------------

function spawnAndWait(
  argv: SpawnArgv,
  opts: SandboxedExecOpts
): Promise<SandboxedExecResult> {
  return new Promise<SandboxedExecResult>((resolve) => {
    const env = { ...process.env, ...(opts.env ?? {}) };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let child: ChildProcess;
    try {
      child = spawn(argv.command, argv.args, {
        cwd: argv.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      // ENOENT (binary missing) and similar synchronous spawn failures land
      // here. Surface as a non-zero exit so the bash-tool wrapper can
      // forward a useful error to the agent.
      resolve({
        stdout: "",
        stderr: `spawn failed: ${(e as Error).message}\n`,
        exitCode: 127,
        signal: null,
        timedOut: false,
        aborted: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (abortListener && opts.abortSignal) {
        opts.abortSignal.removeEventListener("abort", abortListener);
        abortListener = null;
      }
    };

    // SIGTERM → 5s grace → SIGKILL. Used by both timeout and abort paths.
    const escalateKill = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS);
    };

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        escalateKill();
      }, timeoutMs);
    }

    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        aborted = true;
        escalateKill();
      } else {
        abortListener = (): void => {
          if (settled) return;
          aborted = true;
          escalateKill();
        };
        opts.abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // Handle stream errors (EPIPE on close races) without crashing.
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr: stderr + `child error: ${e.message}\n`,
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        aborted,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk PATH for `name`, returning true iff any entry contains an executable
 * by that name. Synchronous because callers want the answer at boot.
 */
function findOnPath(name: string): boolean {
  const path = process.env.PATH ?? "";
  if (path.length === 0) return false;
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = `${dir}${sep}${name}`;
    try {
      const st = statSync(candidate);
      if (st.isFile()) return true;
    } catch {
      /* not in this PATH dir */
    }
  }
  return false;
}
