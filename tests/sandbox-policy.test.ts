/**
 * Tests for `src/sandbox/policy.ts`.
 *
 * Coverage targets per the IMPL-9 brief (≥10 cases):
 *   1. Default state is engaged
 *   2. disable({scope:'next-task'}) flips to unsand
 *   3. disable({scope:'window', windowMinutes:30}) sets expiresAt 30min from now
 *   4. disable({windowMinutes:200}) → ok=false, reason='exceeds_max_window_120'
 *   5. tickExpiration past expiresAt → re-engages
 *   6. forceEngagedOnBoot ALWAYS returns engaged regardless of persisted state
 *      (and emits the audit event)
 *   7. onTaskCompleted with scope='next-task' re-engages
 *   8. onTaskCompleted with scope='window' does NOT re-engage
 *   9. tool-derived flag is captured + persisted across restart
 *  10. Persistence round-trip via JsonStore
 *
 * Plus: tool-derived without sessionAck refused; first-per-session without
 * sessionAck refused; window scope without windowMinutes refused; enable()
 * idempotent; tickExpiration before expiresAt is no-op.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonStore } from "../src/storage/json-store.js";
import { AuditLog } from "../src/audit/log.js";
import { SandboxPolicy, type SandboxState } from "../src/sandbox/policy.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-sandbox-policy-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeStore(): JsonStore<SandboxState> {
  return new JsonStore<SandboxState>(join(workDir, "sandbox.json"));
}

function makeAudit(): AuditLog {
  return new AuditLog({ dir: join(workDir, "audit"), daemonStartTs: Date.now() });
}

function readAuditLines(log: AuditLog): unknown[] {
  const path = log.currentLogPath();
  try {
    const raw = readFileSync(path, "utf8");
    return raw
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s));
  } catch {
    return [];
  }
}

describe("SandboxPolicy — defaults + isSandboxed", () => {
  test("default state is engaged (isSandboxed === true)", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    expect(policy.isSandboxed()).toBe(true);
    expect(policy.getState().kind).toBe("engaged");
  });
});

describe("SandboxPolicy — disable() / scopes", () => {
  test("disable({scope:'next-task'}) flips to unsand and isSandboxed becomes false", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const r = policy.disable({
      scope: "next-task",
      toolDerived: false,
      sessionAck: false,
    });
    expect(r.ok).toBe(true);
    expect(policy.isSandboxed()).toBe(false);
    expect(r.newState?.kind).toBe("unsand");
    if (r.newState?.kind === "unsand") {
      expect(r.newState.scope).toBe("next-task");
      expect(r.newState.expiresAt).toBeNull();
    }
  });

  test("disable({scope:'window', windowMinutes:30}) sets expiresAt 30min from now", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const fixed = 1_700_000_000_000;
    const r = policy.disable({
      scope: "window",
      windowMinutes: 30,
      toolDerived: false,
      sessionAck: false,
      now: fixed,
    });
    expect(r.ok).toBe(true);
    if (r.newState?.kind === "unsand") {
      expect(r.newState.expiresAt).toBe(fixed + 30 * 60_000);
      expect(r.newState.grantedAt).toBe(fixed);
    } else {
      throw new Error("expected unsand state");
    }
  });

  test("disable({windowMinutes:200}) is rejected with exceeds_max_window_120", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const r = policy.disable({
      scope: "window",
      windowMinutes: 200,
      toolDerived: false,
      sessionAck: false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("exceeds_max_window_120");
    // State must remain engaged after rejection.
    expect(policy.isSandboxed()).toBe(true);
  });

  test("disable({scope:'window'}) without windowMinutes is rejected", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const r = policy.disable({
      scope: "window",
      toolDerived: false,
      sessionAck: false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_window_minutes");
    expect(policy.isSandboxed()).toBe(true);
  });

  test("tool-derived disable without sessionAck is rejected", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const r = policy.disable({
      scope: "next-task",
      toolDerived: true,
      sessionAck: false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_tool_derived_ack");
    expect(policy.isSandboxed()).toBe(true);
  });

  test("first-per-session disable without sessionAck is rejected", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const r = policy.disable({
      scope: "next-task",
      toolDerived: false,
      sessionAck: false,
      firstPerSession: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_session_ack");
    expect(policy.isSandboxed()).toBe(true);
  });

  test("tool-derived disable WITH sessionAck succeeds and records the flag", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const r = policy.disable({
      scope: "next-task",
      toolDerived: true,
      sessionAck: true,
    });
    expect(r.ok).toBe(true);
    if (r.newState?.kind === "unsand") {
      expect(r.newState.toolDerivedFlag).toBe(true);
    } else {
      throw new Error("expected unsand state");
    }
  });
});

describe("SandboxPolicy — tickExpiration", () => {
  test("tickExpiration past expiresAt re-engages and reports stateChanged", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const fixed = 2_000_000_000_000;
    policy.disable({
      scope: "window",
      windowMinutes: 1,
      toolDerived: false,
      sessionAck: false,
      now: fixed,
    });
    expect(policy.isSandboxed()).toBe(false);

    const tick = policy.tickExpiration(fixed + 61_000);
    expect(tick.stateChanged).toBe(true);
    expect(tick.newState.kind).toBe("engaged");
    expect(policy.isSandboxed()).toBe(true);
  });

  test("tickExpiration before expiresAt is a no-op", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    const fixed = 2_000_000_000_000;
    policy.disable({
      scope: "window",
      windowMinutes: 30,
      toolDerived: false,
      sessionAck: false,
      now: fixed,
    });
    const tick = policy.tickExpiration(fixed + 60_000);
    expect(tick.stateChanged).toBe(false);
    expect(tick.newState.kind).toBe("unsand");
    expect(policy.isSandboxed()).toBe(false);
  });

  test("tickExpiration on next-task scope is a no-op (windows only)", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    policy.disable({
      scope: "next-task",
      toolDerived: false,
      sessionAck: false,
    });
    const tick = policy.tickExpiration(Date.now() + 1_000_000_000);
    expect(tick.stateChanged).toBe(false);
    expect(policy.isSandboxed()).toBe(false);
  });
});

describe("SandboxPolicy — forceEngagedOnBoot", () => {
  test("ALWAYS returns engaged regardless of persisted state (audit event emitted)", async () => {
    const store = makeStore();
    // Pre-seed disk with an active unsand window — this simulates a daemon
    // that died mid-window and is now rebooting.
    const persisted: SandboxState = {
      kind: "unsand",
      scope: "window",
      expiresAt: Date.now() + 30 * 60_000,
      grantedAt: Date.now(),
      toolDerivedFlag: false,
      firstPerSession: true,
    };
    await store.write(persisted);

    const audit = makeAudit();
    const policy = new SandboxPolicy({ jsonStore: store, auditLog: audit });
    const result = await policy.forceEngagedOnBoot(Date.now());
    expect(result.kind).toBe("engaged");
    expect(policy.isSandboxed()).toBe(true);

    // The audit event is appended async — give the writer a tick to flush.
    await new Promise((r) => setTimeout(r, 50));
    const lines = readAuditLines(audit);
    const evt = lines.find(
      (l) => (l as { event?: string }).event === "sandbox_force_engaged_on_boot"
    ) as { extra?: Record<string, unknown> } | undefined;
    expect(evt).toBeTruthy();
    expect(evt?.extra?.prior_kind).toBe("unsand");
    expect(evt?.extra?.prior_scope).toBe("window");
  });

  test("forceEngagedOnBoot persists the engaged posture so a second boot reads it", async () => {
    const store = makeStore();
    // Seed an unsand state.
    await store.write({
      kind: "unsand",
      scope: "next-task",
      expiresAt: null,
      grantedAt: Date.now(),
      toolDerivedFlag: false,
      firstPerSession: false,
    });
    const policy = new SandboxPolicy({ jsonStore: store });
    await policy.forceEngagedOnBoot(Date.now());
    // Allow the async persist().
    await new Promise((r) => setTimeout(r, 50));
    const onDisk = await store.read();
    expect(onDisk?.kind).toBe("engaged");
  });

  test("forceEngagedOnBoot with no persisted state still emits an audit event", async () => {
    const audit = makeAudit();
    const policy = new SandboxPolicy({ jsonStore: makeStore(), auditLog: audit });
    const result = await policy.forceEngagedOnBoot(Date.now());
    expect(result.kind).toBe("engaged");
    await new Promise((r) => setTimeout(r, 50));
    const lines = readAuditLines(audit);
    const evt = lines.find(
      (l) => (l as { event?: string }).event === "sandbox_force_engaged_on_boot"
    ) as { extra?: Record<string, unknown> } | undefined;
    expect(evt).toBeTruthy();
    // Prior kind comes from the missing-file case — null read → 'unknown'.
    expect(evt?.extra?.prior_kind).toBe("unknown");
  });
});

describe("SandboxPolicy — onTaskCompleted", () => {
  test("onTaskCompleted with scope='next-task' re-engages the sandbox", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    policy.disable({
      scope: "next-task",
      toolDerived: false,
      sessionAck: false,
    });
    expect(policy.isSandboxed()).toBe(false);
    policy.onTaskCompleted();
    expect(policy.isSandboxed()).toBe(true);
  });

  test("onTaskCompleted with scope='window' does NOT re-engage (window outlives task)", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    policy.disable({
      scope: "window",
      windowMinutes: 30,
      toolDerived: false,
      sessionAck: false,
    });
    expect(policy.isSandboxed()).toBe(false);
    policy.onTaskCompleted();
    expect(policy.isSandboxed()).toBe(false);
  });

  test("onTaskCompleted while engaged is a no-op", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    policy.onTaskCompleted();
    expect(policy.isSandboxed()).toBe(true);
  });
});

describe("SandboxPolicy — enable()", () => {
  test("enable() re-engages from any unsand state", () => {
    const policy = new SandboxPolicy({ jsonStore: makeStore() });
    policy.disable({
      scope: "window",
      windowMinutes: 60,
      toolDerived: false,
      sessionAck: false,
    });
    expect(policy.isSandboxed()).toBe(false);
    policy.enable();
    expect(policy.isSandboxed()).toBe(true);
  });

  test("enable() while engaged is idempotent (no audit emission either)", async () => {
    const audit = makeAudit();
    const policy = new SandboxPolicy({ jsonStore: makeStore(), auditLog: audit });
    policy.enable();
    policy.enable();
    await new Promise((r) => setTimeout(r, 25));
    const lines = readAuditLines(audit);
    const offEvents = lines.filter(
      (l) =>
        (l as { event?: string; extra?: Record<string, unknown> }).event ===
          "unsand_disabled" &&
        (l as { extra?: Record<string, unknown> }).extra?.reason === "user_off"
    );
    expect(offEvents.length).toBe(0);
  });
});

describe("SandboxPolicy — persistence round-trip", () => {
  test("disable() writes state that survives a fresh policy instance read", async () => {
    const store = makeStore();
    const p1 = new SandboxPolicy({ jsonStore: store });
    p1.disable({
      scope: "window",
      windowMinutes: 45,
      toolDerived: true,
      sessionAck: true,
    });
    // Allow async persist() to flush.
    await new Promise((r) => setTimeout(r, 50));

    const onDisk = await store.read();
    expect(onDisk?.kind).toBe("unsand");
    if (onDisk?.kind === "unsand") {
      expect(onDisk.scope).toBe("window");
      expect(onDisk.toolDerivedFlag).toBe(true);
      expect(typeof onDisk.expiresAt).toBe("number");
    }
  });

  test("tool-derived flag survives disk round-trip (forensic visibility)", async () => {
    const store = makeStore();
    const p1 = new SandboxPolicy({ jsonStore: store });
    p1.disable({
      scope: "next-task",
      toolDerived: true,
      sessionAck: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    const onDisk = await store.read();
    expect(onDisk?.kind).toBe("unsand");
    if (onDisk?.kind === "unsand") {
      expect(onDisk.toolDerivedFlag).toBe(true);
      expect(onDisk.firstPerSession).toBe(false);
    }
  });
});
