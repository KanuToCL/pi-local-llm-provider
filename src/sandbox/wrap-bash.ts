/**
 * Sandboxed bash tool — replaces pi-mono's default bash via `customTools`.
 *
 * Per W1 SDK spike (~/.pi-comms/sdk-spike.json line 16-26): pi-mono does NOT
 * expose `pi.registerTool` and we cannot wrap pi-mono's internal bash via a
 * spawn hook. The architectural pivot (recorded in this brief, not in the
 * plan file): pi-mono's `createAgentSession` accepts a `customTools` config
 * option; tools are objects from `defineTool`. We provide our OWN bash
 * tool via customTools that wraps everything through the sandbox shim. Pi
 * never sees the default bash — clean replacement, not interception.
 *
 * Logic flow per the IMPL-9 brief:
 *   1. Run classifier.classify(cmd)
 *   2. decision='block'   → return error to agent ("blocked: <reason>"),
 *      emit `classifier_block` audit event
 *   3. decision='confirm' → call confirmTool with action/rationale/risk;
 *      if not approved, return error; if approved, proceed
 *   4. decision='allow' OR confirmed → check sandboxPolicy.isSandboxed():
 *      - sandboxed: execSandboxed
 *      - unsand:    execRaw + sandboxPolicy.onTaskCompleted (callback hook
 *                   driven from upstream task lifecycle, not here — the
 *                   wrapper does NOT call onTaskCompleted itself; that is
 *                   the daemon's responsibility on task end.)
 *   5. Return stdout/stderr/exitCode to agent
 *
 * Type opacity:
 *   - This module imports `defineTool` dynamically through the SDK so the
 *     daemon's TypeScript build does not require pi-coding-agent at compile
 *     time (pi-coding-agent is an `optionalDependency`).
 *   - The exported `defineSandboxedBashTool()` returns `unknown` — the
 *     daemon hands it directly to `customTools` without inspecting the
 *     shape. Tests substitute a mock `defineTool` implementation.
 *
 * Confirm-tool contract:
 *   - We treat the `confirmTool` value as opaque per the brief. The actual
 *     invocation goes through the upstream `Confirm` orchestrator, which
 *     IMPL-7/8 owns. To keep this wrapper testable without that wave, we
 *     accept an `invokeConfirm` function in `WrapBashOpts` that the
 *     orchestrator wires up. Tests pass a stub that returns a predictable
 *     decision.
 */

import { execRaw, execSandboxed } from "./exec.js";
import type { SandboxPolicy } from "./policy.js";

/**
 * Classifier contract (subset). Full implementation lives in IMPL-10's
 * `src/guards/classifier.ts`. We pin only the surface this wrapper needs.
 */
export interface ClassifierDecision {
  decision: "allow" | "confirm" | "block";
  reason?: string;
  severity?: "critical" | "high" | "medium" | "low";
}

export interface BashClassifier {
  classify(cmd: string): ClassifierDecision;
}

/**
 * Audit-event sink. The wrapper emits `classifier_block` and
 * `classifier_confirm_required` here. We type only the methods used so
 * tests can pass a thin stub instead of dragging in `AuditLog`.
 */
export interface BashAuditSink {
  classifierBlock(cmd: string, reason: string | undefined, severity: ClassifierDecision["severity"]): void;
  classifierConfirmRequired(cmd: string, severity: ClassifierDecision["severity"]): void;
}

/**
 * Result of asking the confirm orchestrator to gate a CRITICAL/HIGH cmd.
 *   - approved=true: cmd may run.
 *   - approved=false + reason 'rejected'/'timed_out'/'capped': cmd refused;
 *     the wrapper surfaces a useful error to the agent so it can choose to
 *     `tell()` the user or stop.
 */
export interface ConfirmDecision {
  approved: boolean;
  reason?: "rejected" | "timed_out" | "capped" | "blocked-by-lock";
}

/**
 * Pluggable confirm invocation. The real implementation (IMPL-7/8) wires
 * this to the `Confirm` flow with task-id, channel, etc. The wrapper does
 * not need any of that context — only the cmd string and the classifier's
 * rationale.
 */
export type InvokeConfirm = (req: {
  cmd: string;
  rationale: string;
  risk: string;
  severity: ClassifierDecision["severity"];
}) => Promise<ConfirmDecision>;

export interface WrapBashOpts {
  sandboxPolicy: SandboxPolicy;
  classifier: BashClassifier;
  /** Workspace path; the only RW subtree under sandbox. */
  workspace: string;
  /**
   * Opaque confirm-tool definition (what `defineConfirmTool` returns from
   * IMPL-7). We do not introspect it; we hand it to `defineTool` only if
   * pi-mono needs it referenced — but in practice the daemon registers
   * the confirm tool independently and the bash wrapper invokes
   * `invokeConfirm` directly.
   */
  confirmTool: unknown;
  /** Inject the actual confirm orchestrator call. */
  invokeConfirm: InvokeConfirm;
  /**
   * Inject the SDK's `defineTool`. Call sites pass the value loaded via
   * dynamic import. Tests pass a stub. We type as `unknown` because
   * pi-coding-agent's `defineTool` has a complex generic signature on
   * TypeBox schemas; the daemon does not need that surface here.
   */
  defineTool: (tool: unknown) => unknown;
  /** Optional audit sink for tripwire events. */
  audit?: BashAuditSink;
  /** Optional default per-call timeout (ms). Falls through to `execSandboxed`. */
  defaultTimeoutMs?: number;
}

/**
 * Result returned to the agent. Matches pi-mono's bash tool result shape
 * loosely (text content + structured details). The exact shape is
 * compatibility-checked by the daemon integration tests — not this module.
 */
export interface BashToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
    sandboxed: boolean;
  };
}

/**
 * Build the bash tool definition. Returns whatever `defineTool` returned
 * (typed as `unknown` here for the reasons in the file header).
 *
 * The defined tool's `execute` is the body of the wrapper logic — it
 * runs the classifier, optionally invokes confirm, and finally routes to
 * `execSandboxed` or `execRaw` based on `sandboxPolicy.isSandboxed()`.
 */
export function defineSandboxedBashTool(opts: WrapBashOpts): unknown {
  // The TypeBox-typed parameter schema is opaque to us here; we hand the
  // definition to `defineTool` as an `unknown`-typed object. The agent
  // call site validates the shape against pi-mono's expectations.
  const definition = {
    name: "bash",
    label: "Bash",
    description:
      "Run a shell command. The command is executed inside a sandbox by default; " +
      "use /unsand from the user side to temporarily widen access. CRITICAL/HIGH " +
      "destructive commands additionally require explicit confirm() approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command line to run." },
        timeoutMs: {
          type: "number",
          description: "Optional per-call timeout in ms (default 5 minutes).",
        },
      },
      required: ["command"],
    },
    execute: async (
      _toolCallId: string,
      params: { command?: string; timeoutMs?: number },
      signal: AbortSignal | undefined
    ): Promise<BashToolResult> => {
      return runBash(opts, params, signal);
    },
  };

  return opts.defineTool(definition);
}

/**
 * Exported for direct testing. The defineTool-wrapped path delegates here.
 */
export async function runBash(
  opts: WrapBashOpts,
  params: { command?: string; timeoutMs?: number },
  signal: AbortSignal | undefined
): Promise<BashToolResult> {
  const cmd = (params.command ?? "").trim();
  if (cmd.length === 0) {
    return errorResult("blocked: empty command");
  }

  // Step 1: classifier.
  const verdict = opts.classifier.classify(cmd);

  if (verdict.decision === "block") {
    opts.audit?.classifierBlock(cmd, verdict.reason, verdict.severity);
    return errorResult(`blocked: ${verdict.reason ?? "destructive command pattern"}`);
  }

  if (verdict.decision === "confirm") {
    opts.audit?.classifierConfirmRequired(cmd, verdict.severity);
    const decision = await opts.invokeConfirm({
      cmd,
      rationale: verdict.reason ?? "destructive command pattern",
      risk: verdict.severity ?? "high",
      severity: verdict.severity,
    });
    if (!decision.approved) {
      const reason = decision.reason ?? "rejected";
      return errorResult(`blocked: confirm ${reason}`);
    }
    // approved — fall through to exec.
  }

  // Step 2: route by sandbox state.
  const sandboxed = opts.sandboxPolicy.isSandboxed();
  const execOpts = {
    cmd,
    workspace: opts.workspace,
    timeoutMs: params.timeoutMs ?? opts.defaultTimeoutMs,
    abortSignal: signal,
  };
  const result = await (sandboxed ? execSandboxed(execOpts) : execRaw(execOpts));

  return {
    content: [
      {
        type: "text",
        text: formatAgentText(result, sandboxed),
      },
    ],
    isError: result.exitCode !== 0 || result.timedOut || result.aborted,
    details: {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      aborted: result.aborted,
      sandboxed,
    },
  };
}

function errorResult(message: string): BashToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Compact text body the agent reads. Includes exit code + truncation marker
 * if either stream exceeds a sane budget. The full streams remain on
 * `details.stdout` / `details.stderr` for any caller that needs them.
 */
function formatAgentText(
  r: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean; signal: NodeJS.Signals | null },
  sandboxed: boolean
): string {
  const MAX = 8000;
  const out = truncate(r.stdout, MAX);
  const err = truncate(r.stderr, MAX);
  const tag = sandboxed ? "sandboxed" : "raw";
  const exitInfo = r.signal
    ? `signal=${r.signal}`
    : `exit=${r.exitCode ?? "null"}`;
  const flags = [r.timedOut ? "timed_out" : null, r.aborted ? "aborted" : null]
    .filter(Boolean)
    .join(",");
  const flagsBlock = flags ? ` [${flags}]` : "";
  return [
    `[bash:${tag}] ${exitInfo}${flagsBlock}`,
    out.length > 0 ? `--- stdout ---\n${out}` : "",
    err.length > 0 ? `--- stderr ---\n${err}` : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[...truncated ${s.length - max} bytes]`;
}
