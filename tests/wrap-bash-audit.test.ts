/**
 * Tests the FIX-B-2 #2 audit hooks in `src/sandbox/wrap-bash.ts`:
 *   - `tool_execution_start` fires immediately before exec dispatch with a
 *     SHA256 cmd_hash + sandboxed flag
 *   - `tool_execution_end` fires after exec settles with the same cmd_hash,
 *     a measured duration_ms, plus exit_code/timed_out/aborted
 *
 * We exercise the wrapper through `runBash` (the exported test-direct path)
 * with a stubbed sandboxPolicy + classifier.  The sandboxed-vs-raw routing
 * decision is made via the policy stub; both branches hit the same audit
 * code path because the start/end pair brackets the exec call regardless
 * of routing.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  runBash,
  type BashAuditSink,
  type BashClassifier,
  type WrapBashOpts,
} from "../src/sandbox/wrap-bash.js";
import * as exec from "../src/sandbox/exec.js";
import type { SandboxPolicy } from "../src/sandbox/policy.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function makeAuditSink() {
  const calls: Array<{ kind: string; args: unknown }> = [];
  const sink: BashAuditSink = {
    classifierBlock: (cmd, reason, severity) => {
      calls.push({ kind: "classifierBlock", args: { cmd, reason, severity } });
    },
    classifierConfirmRequired: (cmd, severity) => {
      calls.push({
        kind: "classifierConfirmRequired",
        args: { cmd, severity },
      });
    },
    toolExecutionStart: (args) => {
      calls.push({ kind: "toolExecutionStart", args });
    },
    toolExecutionEnd: (args) => {
      calls.push({ kind: "toolExecutionEnd", args });
    },
  };
  return { sink, calls };
}

function makePolicy(sandboxed: boolean): SandboxPolicy {
  // Only `isSandboxed` is consulted by `runBash`; the rest stays unstubbed.
  return {
    isSandboxed: () => sandboxed,
  } as unknown as SandboxPolicy;
}

const ALLOW: BashClassifier = {
  classify: () => ({ decision: "allow" }),
};

// `vi.spyOn` returns a complex generic; using `any` here keeps the test
// terse without losing call-site type safety on the mocked functions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let execSandboxedSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let execRawSpy: any;

beforeEach(() => {
  execSandboxedSpy = vi.spyOn(exec, "execSandboxed").mockResolvedValue({
    exitCode: 0,
    signal: null,
    stdout: "ok\n",
    stderr: "",
    timedOut: false,
    aborted: false,
  });
  execRawSpy = vi.spyOn(exec, "execRaw").mockResolvedValue({
    exitCode: 0,
    signal: null,
    stdout: "ok\n",
    stderr: "",
    timedOut: false,
    aborted: false,
  });
});

afterEach(() => {
  execSandboxedSpy.mockRestore();
  execRawSpy.mockRestore();
});

describe("wrap-bash audit emission (FIX-B-2 #2)", () => {
  test("emits tool_execution_start AND tool_execution_end with matching cmd_hash (sandboxed path)", async () => {
    const { sink, calls } = makeAuditSink();
    const opts: WrapBashOpts = {
      sandboxPolicy: makePolicy(true),
      classifier: ALLOW,
      workspace: "/tmp/ws",
      confirmTool: {},
      invokeConfirm: async () => ({ approved: true }),
      defineTool: (t) => t,
      audit: sink,
    };

    await runBash(opts, { command: "echo hi" }, undefined);

    const start = calls.find((c) => c.kind === "toolExecutionStart");
    const end = calls.find((c) => c.kind === "toolExecutionEnd");
    expect(start).toBeDefined();
    expect(end).toBeDefined();

    const startArgs = start!.args as {
      cmdHash: string;
      sandboxed: boolean;
    };
    const endArgs = end!.args as {
      cmdHash: string;
      durationMs: number;
      exitCode: number | null;
      timedOut: boolean;
      aborted: boolean;
    };
    expect(startArgs.cmdHash).toBe(sha256("echo hi"));
    expect(startArgs.cmdHash).toBe(endArgs.cmdHash);
    expect(startArgs.sandboxed).toBe(true);
    expect(endArgs.exitCode).toBe(0);
    expect(endArgs.timedOut).toBe(false);
    expect(endArgs.aborted).toBe(false);
    expect(endArgs.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("emits start/end on raw (un-sandboxed) path with sandboxed=false", async () => {
    const { sink, calls } = makeAuditSink();
    const opts: WrapBashOpts = {
      sandboxPolicy: makePolicy(false),
      classifier: ALLOW,
      workspace: "/tmp/ws",
      confirmTool: {},
      invokeConfirm: async () => ({ approved: true }),
      defineTool: (t) => t,
      audit: sink,
    };

    await runBash(opts, { command: "ls" }, undefined);

    const start = calls.find((c) => c.kind === "toolExecutionStart");
    expect((start!.args as { sandboxed: boolean }).sandboxed).toBe(false);
    expect(execRawSpy).toHaveBeenCalledTimes(1);
    expect(execSandboxedSpy).not.toHaveBeenCalled();
  });

  test("does NOT emit tool_execution_start when classifier blocks", async () => {
    const { sink, calls } = makeAuditSink();
    const blocker: BashClassifier = {
      classify: () => ({
        decision: "block",
        reason: "no",
        severity: "critical",
      }),
    };
    const opts: WrapBashOpts = {
      sandboxPolicy: makePolicy(true),
      classifier: blocker,
      workspace: "/tmp/ws",
      confirmTool: {},
      invokeConfirm: async () => ({ approved: true }),
      defineTool: (t) => t,
      audit: sink,
    };

    await runBash(opts, { command: "rm -rf /" }, undefined);

    expect(calls.find((c) => c.kind === "toolExecutionStart")).toBeUndefined();
    expect(calls.find((c) => c.kind === "toolExecutionEnd")).toBeUndefined();
    expect(calls.find((c) => c.kind === "classifierBlock")).toBeDefined();
  });

  test("propagates timed_out + aborted flags into tool_execution_end", async () => {
    execSandboxedSpy.mockResolvedValue({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "killed",
      timedOut: true,
      aborted: false,
    });
    const { sink, calls } = makeAuditSink();
    const opts: WrapBashOpts = {
      sandboxPolicy: makePolicy(true),
      classifier: ALLOW,
      workspace: "/tmp/ws",
      confirmTool: {},
      invokeConfirm: async () => ({ approved: true }),
      defineTool: (t) => t,
      audit: sink,
    };

    await runBash(opts, { command: "sleep 999" }, undefined);

    const end = calls.find((c) => c.kind === "toolExecutionEnd");
    const endArgs = end!.args as {
      timedOut: boolean;
      exitCode: number | null;
    };
    expect(endArgs.timedOut).toBe(true);
    expect(endArgs.exitCode).toBeNull();
  });
});
