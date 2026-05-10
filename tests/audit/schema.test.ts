/**
 * Tests for v0.3 audit schema additions (Plan v3 §1.1).
 *
 * Coverage:
 *   1. AuditEventTypeSchema (the closed write-side enum) ACCEPTS the three
 *      new v0.3 telegram_restart* event kinds.
 *   2. AuditEntrySchema parses each new event kind end-to-end.
 *   3. RestartReasonSchema accepts the two declared values; rejects
 *      arbitrary strings.
 *   4. Forward-compat (Integration I1): AuditEntrySchema parses a future
 *      event kind not declared in AuditEventTypeSchema (proves the read-side
 *      relaxation from z.enum -> z.string()).
 *   5. AuditEntrySchema still rejects empty / oversized event identifiers
 *      so the relaxation cannot be abused.
 *   6. AuditEntrySchema accepts a telegram_restart row carrying an
 *      arbitrary string in extra.reason — but a write-side caller using
 *      RestartReasonSchema to validate THEIR input would catch the same
 *      payload (closed-enum discipline at the call site, per §1.1b).
 *
 * v0.3.1 additions (Plan v3 §1.0.1, MIB-2305 §4 + §5):
 *   7. AuditEventTypeSchema accepts `sandbox_denial_loop_broken` (F3).
 *   8. AuditEventTypeSchema accepts `daemon_boot_failed` (F8).
 *   9. AuditEntrySchema parses representative payloads for each new kind.
 *   See `forward-compat` block below — its existing
 *   `future_v0_4_event_kind` assertion is the regression guard for the
 *   v0.3 §G7 read-side relaxation; v0.3.1 must not break it.
 */

import { describe, expect, test } from "vitest";

import {
  AuditEntrySchema,
  AuditEventTypeSchema,
  RestartReasonSchema,
} from "../../src/audit/schema.js";

const baseRow = {
  ts: "2026-05-04T12:00:00.000Z",
  daemon_uptime_s: 42,
  task_id: null,
  channel: "system",
  sender_id_hash: null,
} as const;

describe("AuditEventTypeSchema (write-side closed enum)", () => {
  test("accepts telegram_restart", () => {
    expect(AuditEventTypeSchema.parse("telegram_restart")).toBe(
      "telegram_restart",
    );
  });

  test("accepts telegram_restart_failed", () => {
    expect(AuditEventTypeSchema.parse("telegram_restart_failed")).toBe(
      "telegram_restart_failed",
    );
  });

  test("accepts telegram_restart_skipped", () => {
    expect(AuditEventTypeSchema.parse("telegram_restart_skipped")).toBe(
      "telegram_restart_skipped",
    );
  });

  test("rejects an unknown event kind at write-time", () => {
    expect(() =>
      AuditEventTypeSchema.parse("future_v0_4_event_kind"),
    ).toThrow();
  });
});

describe("AuditEntrySchema parses v0.3 event kinds", () => {
  test("telegram_restart row parses with extra.reason='poll_silent_too_long'", () => {
    const row = {
      ...baseRow,
      event: "telegram_restart" as const,
      channel: "telegram" as const,
      extra: { reason: "poll_silent_too_long", attempt: 1 },
    };
    expect(() => AuditEntrySchema.parse(row)).not.toThrow();
    const parsed = AuditEntrySchema.parse(row);
    expect(parsed.event).toBe("telegram_restart");
    expect(parsed.extra?.reason).toBe("poll_silent_too_long");
  });

  test("telegram_restart_failed row parses with error_class set", () => {
    const row = {
      ...baseRow,
      event: "telegram_restart_failed" as const,
      channel: "telegram" as const,
      error_class: "GrammyError",
      extra: { reason: "poll_silent_too_long", attempt: 2 },
    };
    expect(() => AuditEntrySchema.parse(row)).not.toThrow();
    const parsed = AuditEntrySchema.parse(row);
    expect(parsed.event).toBe("telegram_restart_failed");
    expect(parsed.error_class).toBe("GrammyError");
  });

  test("telegram_restart_skipped row parses with cooldown context", () => {
    const row = {
      ...baseRow,
      event: "telegram_restart_skipped" as const,
      channel: "telegram" as const,
      extra: {
        reason: "poll_silent_too_long",
        cooldown_remaining_s: 27,
      },
    };
    expect(() => AuditEntrySchema.parse(row)).not.toThrow();
    const parsed = AuditEntrySchema.parse(row);
    expect(parsed.event).toBe("telegram_restart_skipped");
    expect(parsed.extra?.cooldown_remaining_s).toBe(27);
  });
});

describe("AuditEventTypeSchema accepts v0.3.1 event kinds", () => {
  // Plan v3 §1.0.1 — schema-add blocking gate before W1.1 implementers
  // (IMPL-4 emits sandbox_denial_loop_broken; IMPL-6 emits daemon_boot_failed).
  test("accepts sandbox_denial_loop_broken (F3)", () => {
    expect(AuditEventTypeSchema.parse("sandbox_denial_loop_broken")).toBe(
      "sandbox_denial_loop_broken",
    );
  });

  test("accepts daemon_boot_failed (F8)", () => {
    expect(AuditEventTypeSchema.parse("daemon_boot_failed")).toBe(
      "daemon_boot_failed",
    );
  });
});

describe("AuditEntrySchema parses v0.3.1 event kinds", () => {
  test("sandbox_denial_loop_broken row parses with F3 forensic payload", () => {
    // Per plan §F3 / Round-2 NB-9: top-level sender_id_hash / channel /
    // task_id; extra carries first_denial_age_ms (number) +
    // last_cmd_hash_first8 (string). Scalars only — schema rejects nested.
    const row = {
      ...baseRow,
      task_id: "task-abc-123",
      sender_id_hash: "deadbeef".repeat(8),
      event: "sandbox_denial_loop_broken" as const,
      channel: "telegram" as const,
      extra: {
        first_denial_age_ms: 4321,
        last_cmd_hash_first8: "ab12cd34",
      },
    };
    expect(() => AuditEntrySchema.parse(row)).not.toThrow();
    const parsed = AuditEntrySchema.parse(row);
    expect(parsed.event).toBe("sandbox_denial_loop_broken");
    expect(parsed.extra?.first_denial_age_ms).toBe(4321);
    expect(parsed.extra?.last_cmd_hash_first8).toBe("ab12cd34");
  });

  test("daemon_boot_failed row parses with F8 boot-failure payload", () => {
    // Per plan §F8 — fired from start() before non-zero exit (typically
    // exit 2) when a boot-blocking step fails. error_class identifies the
    // failure class; extra carries the boot-step + waited duration.
    const row = {
      ...baseRow,
      event: "daemon_boot_failed" as const,
      channel: "system" as const,
      error_class: "DaemonBootError",
      duration_ms: 300_000,
      extra: {
        step: "studio_model_wait",
        waited_ms: 300_000,
      },
    };
    expect(() => AuditEntrySchema.parse(row)).not.toThrow();
    const parsed = AuditEntrySchema.parse(row);
    expect(parsed.event).toBe("daemon_boot_failed");
    expect(parsed.error_class).toBe("DaemonBootError");
    expect(parsed.extra?.step).toBe("studio_model_wait");
  });
});

describe("RestartReasonSchema (closed enum, §1.1b)", () => {
  test("accepts 'poll_silent_too_long'", () => {
    expect(RestartReasonSchema.parse("poll_silent_too_long")).toBe(
      "poll_silent_too_long",
    );
  });

  test("accepts 'manual'", () => {
    expect(RestartReasonSchema.parse("manual")).toBe("manual");
  });

  test("rejects an arbitrary string", () => {
    // §1.1b: future free-form reason additions require enum extension.
    // A write-side caller that validates `extra.reason` via this schema
    // catches operator-supplied payloads BEFORE they reach the audit log.
    expect(() => RestartReasonSchema.parse("arbitrary string")).toThrow();
  });

  test("rejects an empty string", () => {
    expect(() => RestartReasonSchema.parse("")).toThrow();
  });
});

describe("AuditEntrySchema forward-compat (Integration I1)", () => {
  test("parses a future v0.4 event kind without ZodError", () => {
    // Per §1.1c: v0.2.2 daemon must be able to replay a v0.3+ audit log
    // even when the log contains event kinds the daemon's compiled enum
    // does not know about. Read-side is z.string() with a length refine;
    // write-side uses the typed AuditEventTypeSchema constant.
    const futureRow = {
      ...baseRow,
      event: "future_v0_4_event_kind",
      channel: "telegram" as const,
    };
    expect(() => AuditEntrySchema.parse(futureRow)).not.toThrow();
    const parsed = AuditEntrySchema.parse(futureRow);
    expect(parsed.event).toBe("future_v0_4_event_kind");
  });

  test("rejects an empty event string", () => {
    const row = {
      ...baseRow,
      event: "",
      channel: "system" as const,
    };
    expect(() => AuditEntrySchema.parse(row)).toThrow(
      /audit event must be a non-empty short identifier/,
    );
  });

  test("rejects an event identifier longer than 64 chars", () => {
    const row = {
      ...baseRow,
      event: "x".repeat(65),
      channel: "system" as const,
    };
    expect(() => AuditEntrySchema.parse(row)).toThrow(
      /audit event must be a non-empty short identifier/,
    );
  });

  test("accepts an event identifier exactly 64 chars long", () => {
    const row = {
      ...baseRow,
      event: "y".repeat(64),
      channel: "system" as const,
    };
    expect(() => AuditEntrySchema.parse(row)).not.toThrow();
  });
});

describe("AuditEntrySchema for telegram_restart and extra.reason", () => {
  // §1.1d: AuditEntrySchema does NOT enforce the closed RestartReason enum
  // on extra.reason — extra is a generic Record<string, scalar>. The
  // closed-enum discipline lives at the WRITE-SIDE call sites that
  // construct telegram_restart* rows (they validate via RestartReasonSchema
  // before append). This test documents that contract by asserting:
  //   - the schema-level parse permits an arbitrary extra.reason (so a
  //     v0.3 daemon parsing a v0.4 row with a new reason value still
  //     succeeds — same forward-compat shape as the event field), AND
  //   - the write-side RestartReasonSchema rejects the same payload
  //     when used as a guard.
  test("schema-level: AuditEntrySchema accepts extra.reason='arbitrary string'", () => {
    const row = {
      ...baseRow,
      event: "telegram_restart" as const,
      channel: "telegram" as const,
      extra: { reason: "arbitrary string" },
    };
    expect(() => AuditEntrySchema.parse(row)).not.toThrow();
  });

  test("call-site discipline: RestartReasonSchema rejects the same payload", () => {
    const arbitraryReason = "arbitrary string";
    expect(() => RestartReasonSchema.parse(arbitraryReason)).toThrow();
  });
});
