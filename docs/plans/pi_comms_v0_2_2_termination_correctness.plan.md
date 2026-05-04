# Plan: pi-comms v0.2.2 — Termination Correctness + State-Machine Cyclicity

**Plan version:** v2.1 (post-Adversarial-narrow-re-bless on v2; folds in NEW-1/2/4 BLOCKERS + 5 NITs from re-bless)
**Goal**: Fix the two compounding architectural defects in v0.2.1 that made multi-message follow-ups silently drop in production (per `docs/MIB-2026-05-03-2336.md`):

1. **Premature termination** — IMPL-D-1's null-mapper-symmetry fires `markTaskCompleted` on EVERY `message_end` event. Pi-mono fires multiple per run (user/tool/empty-assistant messages). Smoking gun: `duration_ms=7` across all task_completed audit rows.
2. **State-machine trap** — TaskState's `completed → idle` edge exists but nothing calls it. Subsequent inbounds' CAS to running silently fail. No audit, no error.

Plus 14 multi-elder convergent findings folded in.

---

## Architectural foundation (VERIFIED from pi-mono source, not just types)

The plan rests on `await session.prompt()` being the canonical terminal signal. **Verified empirically** from compiled JS source (NOT just .d.ts):

- `node_modules/@mariozechner/pi-agent-core/dist/agent.js:215-221` — `Agent.prompt()` awaits `runPromptMessages()`
- Lines 259-263 — `runPromptMessages` awaits `runWithLifecycle(executor)`
- Lines 303-325 — `runWithLifecycle` awaits `executor(signal)` (the entire agent loop). All events fire through `processEvents` inside this await
- Lines 356-396 — `processEvents` line 393-395: `for (const listener of this.listeners) { await listener(event, signal); }` — **every subscriber listener is awaited inside processEvents**
- Line 322-324 — `finally { this.finishRun(); }` — completes the lifecycle

So `await Agent.prompt()` resolves AFTER: agent loop completes → all events processed → all listeners awaited → finishRun fires. **The duration_ms=7 in v0.2.1 was 100% caused by IMPL-D-1's null-mapper-symmetry firing markTaskCompleted on every message_end. NOT a pi-mono early-resolve bug.** Choice D is the correct architecture.

This citation kills Adversarial's BLESS-of-plan B5 ("Choice D may be the same bug"). The remaining concerns are about correct implementation of Choice D, not about Choice D itself.

---

## Architecture summary

- **Single-source termination via `session.prompt()` Promise resolution.** Verified above.
- **Subscriber becomes fan-out-only.** No more `markTaskCompleted` from message_end / agent_end / reply mirror. The subscriber's job is to translate pi-mono events into ChannelEvents and fan out to sinks. State transitions are owned exclusively by `handleInbound` (the canonical task lifecycle owner).
- **`TaskStateManager.markTerminalAndIdle()` becomes the single atomic primitive for terminal-state writes.** Per Architect BLESS-B2: instead of every consumer doing the running→completed→idle dance, the state machine itself owns the invariant. Helpers in SessionManager wrap this primitive for audit-emission orchestration.
- **`handleInbound` owns the full state transition cycle via extracted helpers** (`normalizeTerminalState`, `emitCasFailure`). Per Architect/PE convergence on handleInbound size.
- **Defensive: silent CAS failures become audit-logged** with `extra.stuck_task_id` for forensic correlation. Plus mandatory `extra` field type-safety.
- **Defensive: `task_completed_suspiciously_fast` audit event** when duration_ms < 100ms. Catches future regressions of the v0.2.1 bug class.
- **Defensive: channel-side inbound observability promoted from debug→info**, with NO content fields per Security BLESS-B1.

---

## Files Touched (final)

| Wave | Implementer | Files | Action |
|---|---|---|---|
| 1 | IMPL-V2-A | `src/lib/task-state.ts` | Add `markTerminalAndIdle()` atomic primitive + flush() helper for crash-window safety |
| 1 | IMPL-V2-A | `src/session.ts` | Refactor handleInbound (extract `normalizeTerminalState` + `emitCasFailure`); strip subscriber-based termination; switch to `taskState.markTerminalAndIdle()`; add `task_completed_suspiciously_fast` emit |
| 1 | IMPL-V2-A | `src/audit/schema.ts` | Add `task_state_cas_failed` + `task_completed_suspiciously_fast` + `task_state_recovered_on_restart` (NEW per Adversarial re-bless NEW-2); telegram_inbound + whatsapp_inbound (NEW). VERIFY (do not re-add) `inbound_rate_limited` already at line 91 |
| 1 | IMPL-V2-A | `tests/session.test.ts` | Refactor old tests; add 7 new tests with explicit shapes (per Testing BLESS-B1/B2/B3) |
| 1 | IMPL-V2-A | `tests/lib/task-state.test.ts` | Add tests for `markTerminalAndIdle` + restoreFromDisk for terminal states |
| 1 | IMPL-V2-B | `src/channels/telegram.ts` | Promote inbound log debug→info (no content); verify rate-limiter audit emit |
| 1 | IMPL-V2-B | `src/channels/whatsapp.ts` | Same as telegram |
| 1 | IMPL-V2-B | `src/lib/inbound-rate-limit.ts` | NO CHANGE — already returns reason; channels already emit audit |
| 1 | IMPL-V2-B | `src/utils/operator-logger.ts` | Add icons; add diagnostic-mode hint to startup banner |
| 1 | IMPL-V2-C | `src/daemon.ts` | Find all `tryTransition({kind: "cancelled"})` call sites — confirmed at lines 710-741 (`onCancelTask`) + 925-950 (shutdown handler) per Adversarial re-bless B6; use new `taskState.markTerminalAndIdle()` |
| 1 | IMPL-V2-C | `docs/INSTALL.md` | Diagnostic mode section with Security 4-point caveat (per Security BLESS-B4) |
| 1 | IMPL-V2-C | `README.md` | One-line "If something seems broken, see Diagnostic mode in INSTALL.md" |
| 1 | IMPL-V2-C | `SECURITY.md` | New §R-DOS: lock-hold-time increase post-v0.2.2 (per Security BLESS-B3) |

---

# Phase A — Architectural fix

## IMPL-V2-A — TaskState atomic primitive + handleInbound refactor + termination ownership

### A.1 — Add `TaskStateManager.markTerminalAndIdle()` atomic primitive

**File**: `src/lib/task-state.ts`

The Architect Elder (BLESS-B2) and Data Guardian Elder (BLESS-B1) converged: instead of every consumer doing the running→completed→idle two-step dance with crash-window vulnerability, promote the invariant into the state machine itself. The `completed` / `failed` / `cancelled` states become true ephemeral markers — they exist for the duration of the persistence write only.

Add to `TaskStateManager`:

```typescript
/**
 * Atomic terminal-and-idle transition: writes the terminal state to disk
 * (for audit-trail purposes), then immediately writes idle to disk so the
 * state machine returns to its single resting state. Both writes go through
 * JsonStore's serial queue (FIFO-guaranteed), and we await the IDLE write
 * to flush before returning so a crash post-call cannot leave the daemon
 * trapped in a terminal state.
 *
 * This is the SINGLE PATH to a terminal state in v0.2.2. Every caller
 * (handleInbound's mark helpers, watchdog, /cancel) MUST use this. The
 * cyclicity guard at handleInbound entry is defense-in-depth only.
 *
 * Returns the original CAS result so callers can audit-log + react. If
 * the terminal CAS fails (e.g., race with another terminator), returns
 * { ok: false, reason } and does NOT attempt the idle CAS.
 */
async markTerminalAndIdle(terminal: TaskState & { kind: "completed" | "failed" | "cancelled" }): Promise<TransitionResult> {
  const terminalResult = this.tryTransition(terminal);
  if (!terminalResult.ok) {
    return terminalResult;
  }

  // Idle CAS: should always succeed (terminal → idle is in transition table).
  // If it doesn't, something has gone deeply wrong; return the failure
  // so the caller can audit-log it as a state-machine inconsistency.
  const idleResult = this.tryTransition({ kind: "idle" });
  if (!idleResult.ok) {
    return idleResult;
  }

  // Crash-window safety: await the idle write to flush before returning.
  // Without this, a crash between the in-memory CAS and the JsonStore
  // write leaves disk in `terminal` state, which the cyclicity guard at
  // handleInbound entry can recover from but produces audit-trail noise.
  // Per Data Guardian BLESS-B1.
  await this.flush();

  return { ok: true };
}

// NOTE per Adversarial re-bless NEW-5: TaskStateManager ALREADY has a flush()
// method (existing src/lib/task-state.ts:263-265) that propagates errors
// without swallowing. USE THAT existing method; do NOT add a duplicate. The
// existing propagating semantics are correct — disk-full or IO errors during
// terminal-state flush should be loud (caller can audit-log), not swallowed.
```

Update `restoreFromDisk` JSDoc + behavior per Adversarial BLESS-B4 + PE BLESS-B1:

```typescript
/**
 * Read on-disk state and force-reset to idle.
 *
 * Pre-v0.2.2: terminal states (completed/failed/cancelled) on disk meant
 * "task ran cleanly to completion before previous shutdown." Drained to idle
 * silently.
 *
 * v0.2.2 contract change: terminal states are EPHEMERAL markers that should
 * never persist long-term — markTerminalAndIdle awaits the idle-flush before
 * returning. If we find a terminal state on disk, it indicates a crash
 * between the terminal CAS and the idle flush. The user MAY have received
 * the reply (subscriber fanOut fires before prompt() resolves) or may not.
 * We emit task_state_recovered_on_restart audit event with the prior taskId
 * so post-incident review can correlate with channel-side delivery records.
 */
async restoreFromDisk(): Promise<RestoreResult> {
  // ... existing read logic ...
  const priorState = /* parsed */;
  let abandoned: AbandonedTaskInfo | null = null;
  let recovered: RecoveredTaskInfo | null = null;

  if (priorState.kind === "running" || priorState.kind === "backgrounded") {
    abandoned = { taskId: priorState.taskId, channel: priorState.channel, ... };
  } else if (priorState.kind === "completed" || priorState.kind === "failed" || priorState.kind === "cancelled") {
    // v0.2.2: terminal state on disk = crash between terminal CAS and idle flush
    recovered = { taskId: priorState.taskId, priorKind: priorState.kind };
  }

  this.state = { kind: "idle" };
  await this.flush();
  // Per Adversarial re-bless NEW-4: PRESERVE the existing `priorState` field
  // in RestoreResult — callers (session.ts:321 + tests/lib/task-state.test.ts)
  // depend on it. Add `recovered` as a NEW field; do not drop priorState.
  return { priorState, abandoned, recovered };
}
```

```typescript
// New interface, defined per Adversarial re-bless NEW-8:
export interface RecoveredTaskInfo {
  taskId: string;
  priorKind: "completed" | "failed" | "cancelled";
}
```

(Caller — daemon boot — emits `task_state_recovered_on_restart` audit event when recovered is non-null.)

### A.2 — Refactor `handleInbound` with extracted helpers

**File**: `src/session.ts`

Per Architect/PE convergence on handleInbound size, extract two private helpers:

```typescript
/**
 * Cyclicity-normalize: if state is terminal (completed/failed/cancelled),
 * transition to idle so the next CAS to running can succeed. This is
 * defense-in-depth: in v0.2.2, every terminator uses
 * `taskState.markTerminalAndIdle` which transitions through to idle
 * atomically — so this guard should never fire in practice. If it does,
 * something has bypassed the markTerminalAndIdle primitive, which is
 * worth a log line for forensics.
 */
private async normalizeTerminalState(channel: ChannelId): Promise<{ ok: boolean }> {
  const current = this.opts.taskState.get();
  if (current.kind !== "completed" && current.kind !== "failed" && current.kind !== "cancelled") {
    return { ok: true };
  }

  // Capture the stuck taskId for forensic correlation (per Data Guardian S2 + Obs W2 + Architect convergence).
  const stuckTaskId = current.taskId;

  const idleResult = this.opts.taskState.tryTransition({ kind: "idle" });
  if (!idleResult.ok) {
    this.emitCasFailure({
      from: current.kind,
      to: "idle",
      reason: idleResult.reason,
      context: "handleInbound:cyclicity-normalize",
      channel,
      stuckTaskId,
    });
    return { ok: false };
  }

  this.opts.operatorLogger?.debug("task_state_normalized_to_idle", {
    from: current.kind,
    stuck_task_id: stuckTaskId,
  });
  return { ok: true };
}

/**
 * Centralized audit + operator log for state-machine CAS failures.
 *
 * - Terminal-state CAS losses (race between watchdog and post-prompt mark)
 *   are EXPECTED under concurrency; these emit at debug level only.
 * - Idle → CAS failures are TRUE BUGS and emit at warn level + audit row.
 *
 * Per Adversarial BLESS-W2 + PE BLESS-S2 (demote terminal-CAS races to debug).
 */
private emitCasFailure(opts: {
  from: TaskKind;
  to: TaskKind;
  reason: string | undefined;
  context: string;
  channel: ChannelId;
  stuckTaskId?: string;
}): void {
  // Per Adversarial re-bless NEW-1: include `from === "idle"` in the
  // terminal-race set. Common case: cancel/watchdog races with prompt()
  // resolution. Cancel handler uses markTerminalAndIdle which DRAINS to
  // idle. By the time handleInbound's catch fires markTaskFailedAndIdle,
  // state is `idle` (not `cancelled`). The terminal CAS `idle → failed`
  // returns ok:false; without this expansion, every successful cancel
  // would emit a spurious "true bug" warn + audit row.
  const TERMINAL_RACE_KINDS = new Set(["completed", "failed", "cancelled", "idle"]);
  const isTerminalRace = TERMINAL_RACE_KINDS.has(opts.from)
    && TERMINAL_RACE_KINDS.has(opts.to);

  if (isTerminalRace) {
    this.opts.operatorLogger?.debug("task_state_cas_lost_race", {
      from: opts.from,
      to: opts.to,
      context: opts.context,
      ...(opts.stuckTaskId ? { task_id: opts.stuckTaskId } : {}),
    });
    return;
  }

  // True bug — log warn + audit
  this.opts.operatorLogger?.warn("task_state_cas_failed", {
    from: opts.from,
    to: opts.to,
    reason: opts.reason ?? "unknown",
    context: opts.context,
    ...(opts.stuckTaskId ? { task_id: opts.stuckTaskId } : {}),
  });
  void this.opts.auditLog.append({
    event: "task_state_cas_failed",
    task_id: opts.stuckTaskId ?? null,
    channel: "system",  // per Adversarial BLESS-B1 #3 (daemon-internal bookkeeping)
    sender_id_hash: null,
    extra: {
      from: opts.from,
      to: opts.to,
      // Per Adversarial BLESS-B1 #1: zod requires non-undefined values.
      // Per Security BLESS-B2: never include user-derived strings here.
      reason: opts.reason ?? "unknown",
      context: opts.context,
    },
  }).catch(() => undefined);
}
```

Now refactored `handleInbound`:

```typescript
async handleInbound(msg: InboundMessage): Promise<void> {
  if (!this.session) {
    throw new Error("SessionManager.handleInbound called before init()");
  }

  await this.globalQueue.run("global", async () => {
    const current = this.opts.taskState.get();

    // Outer guard: drop if a task is in flight.
    if (current.kind === "running" || current.kind === "backgrounded") {
      // ... existing serial_queue_blocked path with FIX-W4-B-2 cooldown ...
      return;
    }

    // Cyclicity-normalize (defense-in-depth; should be no-op given markTerminalAndIdle).
    const normalizeResult = await this.normalizeTerminalState(msg.channel);
    if (!normalizeResult.ok) {
      // Audit + operator log already fired inside normalizeTerminalState.
      return;
    }

    // CAS to running. Capture full snapshot to thread channel/startedAt to mark helpers
    // (per Adversarial BLESS-B2 — don't lose state.channel via msg.channel shadowing).
    const taskId = freshTaskId();
    const startedAt = this.now();
    const transitionResult = this.opts.taskState.tryTransition({
      kind: "running",
      taskId,
      startedAt,
      channel: msg.channel,
      userMessage: msg.text,
      abort: new AbortController(),
    });
    if (!transitionResult.ok) {
      this.emitCasFailure({
        from: current.kind,
        to: "running",
        reason: transitionResult.reason,
        context: "handleInbound:cas-to-running",
        channel: msg.channel,
      });
      // Per UX BLESS-W7: also emit user-facing notice so they don't see silent drop.
      void this.emitUserFacingNotice(msg.channel, "info",
        "pi: failed to start your request — please re-send.");
      return;
    }

    // ... existing task_started audit + scheduleAutoPromote + scheduleWatchdog + checkForStudioModelSwap ...

    let didThrow = false;
    let errorMessage: string | null = null;
    try {
      // Capture state.channel from running snapshot for use in mark helpers.
      const live = this.opts.taskState.get();
      const signal = (live.kind === "running" || live.kind === "backgrounded")
        ? live.abort.signal
        : undefined;
      // CRITICAL: pi-mono's prompt() resolves AFTER agent_end listeners settle.
      // Verified from agent.js source — see plan §"Architectural foundation".
      // This is the canonical terminal signal.
      await this.session.prompt(msg.text, { signal });
    } catch (err) {
      didThrow = true;
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      // Always-runs cleanup per Integration W4 + PE W2.
      this.clearAutoPromote();
      this.clearWatchdog();  // not "clearWatchdogIfRunning" — that doesn't exist (Integration W5)
      try { this.opts.sandboxPolicy.onTaskCompleted(); } catch { /* best effort */ }
    }

    const finishedAt = this.now();
    const durationMs = Math.max(0, finishedAt - startedAt);
    // Re-read state to capture channel from the running snapshot for audit row provenance.
    const finalLive = this.opts.taskState.get();
    const auditChannel = (finalLive.kind === "running" || finalLive.kind === "backgrounded")
      ? finalLive.channel
      : msg.channel;  // fallback if state already terminated by watchdog/cancel race

    if (didThrow) {
      await this.markTaskFailedAndIdle(taskId, startedAt, finishedAt, auditChannel, errorMessage);
    } else {
      await this.markTaskCompletedAndIdle(taskId, startedAt, finishedAt, auditChannel, durationMs);
    }
  });
}
```

### A.3 — `markTaskCompletedAndIdle` / `markTaskFailedAndIdle` use the atomic primitive

**Important per Adversarial re-bless NEW-3 (security defense-in-depth):** the v0.2.1 catch path includes `error_class: redactCredentialShapes(error.slice(0, 200))` (session.ts:628) to prevent Bearer-token leakage from pi-mono error chains into the audit log. `markTaskFailedAndIdle` MUST preserve this. Code below shows it explicitly.

```typescript
private async markTaskCompletedAndIdle(
  taskId: string, startedAt: number, finishedAt: number,
  channel: ChannelId, durationMs: number,
): Promise<void> {
  const result = await this.opts.taskState.markTerminalAndIdle({
    kind: "completed", taskId, startedAt, finishedAt,
  });
  if (!result.ok) {
    // Race-lost — task was cancelled / failed by watchdog or /cancel between
    // prompt() resolution and this call. Demoted to debug (Adversarial W2 + PE S2).
    this.emitCasFailure({
      from: this.opts.taskState.get().kind,
      to: "completed",
      reason: result.reason,
      context: "markTaskCompletedAndIdle:terminal-race-lost",
      channel,
      stuckTaskId: taskId,
    });
    return;
  }

  // Audit + operator log (the existing side effects, unchanged).
  void this.opts.auditLog.append({
    event: "task_completed",
    task_id: taskId, channel, sender_id_hash: null,
    duration_ms: durationMs,
  }).catch(() => undefined);
  this.opts.operatorLogger?.info("task_completed", { task_id: taskId });

  // Defense-in-depth alarm per Observability BLESS-W1: catch future regressions
  // of v0.2.1's premature-termination bug class. Threshold = 100ms (below the
  // realistic floor of HTTP roundtrip + token streaming).
  if (durationMs < 100) {
    this.opts.operatorLogger?.warn("task_completed_suspiciously_fast", {
      task_id: taskId, duration_ms: durationMs, threshold_ms: 100,
    });
    void this.opts.auditLog.append({
      event: "task_completed_suspiciously_fast",
      task_id: taskId, channel, sender_id_hash: null,
      duration_ms: durationMs,
    }).catch(() => undefined);
  }
}
```

(Parallel `markTaskFailedAndIdle` with same pattern, audit event = `task_failed`.)

### A.4 — Strip subscriber-based markTaskCompleted firing — explicit deletion checklist

Per Adversarial re-bless NEW-6 (the v1 abbreviation was ambiguous). Implementer MUST execute ALL of the following deletions/transformations:

1. **DELETE** the `if (evt && (evt.type === "agent_end" || evt.type === "message_end")) { this.markTaskCompleted(); }` branch in the subscriber's `if (!channelEvent)` block (currently around `src/session.ts:1287-1294`). Replace with a no-op (just the heartbeat touch via `onPiActivity` stays).

2. **DELETE** the belt-and-suspenders `if (channelEvent.type === "reply") this.markTaskCompleted();` mirror at `src/session.ts:1341-1343` (the `shouldMarkCompleted` flag and its conditional block).

3. **DELETE** the entire `markTaskCompleted()` private method (`src/session.ts:1361-1404`). It's now orphaned — its callers are all gone, and the new `markTaskCompletedAndIdle` / `markTaskFailedAndIdle` helpers replace it.

4. **KEEP** the S4 task_completed rewrite for backgrounded (`src/session.ts:1316-1325`) — it's the cosmetic UX layer, no state side-effect. Per plan §"Pitfalls Catalog" P5, this still works correctly post-v0.2.2 because state is `backgrounded` until `await prompt()` returns.

5. **KEEP** the `onPiActivity` heartbeat touch (`src/session.ts:1225-1236`) — fires on `message_start | message_end | tool_execution_start | agent_start`, unrelated to termination.

6. **KEEP** the post-abort silence gate (`src/session.ts:1247-1251`) — drops fan-out when state is `cancelled`. Still needed for tail events from a cancelled task.

After these edits, the subscriber's responsibilities are exactly: heartbeat touch, watchdog tool-activity reset, post-abort silence gate, soft-swap detection trigger, S4 task_completed cosmetic rewrite, and ChannelEvent fan-out to sinks. NO state transitions. NO termination triggers.

### A.5 — Watchdog + cancel paths use `markTerminalAndIdle`

**File**: `src/session.ts` `fireWatchdog`

```typescript
private async fireWatchdog(taskId: string): Promise<void> {
  // ... existing CAS guard logic ...
  const result = await this.opts.taskState.markTerminalAndIdle({
    kind: "failed", taskId, startedAt: state.startedAt,
    finishedAt: this.now(), error: "watchdog_no_terminal_event",
  });
  if (!result.ok) {
    this.emitCasFailure({...});
    return;
  }
  // ... existing audit + system_notice emit ...
}
```

**File**: `src/daemon.ts` + `src/ipc/server.ts` (cancel slash-command handler — IMPL-V2-C territory):

Per Adversarial BLESS-B6: enumerate cancel call sites. Use `markTerminalAndIdle({kind: "cancelled", ...})` for each.

### A.6 — Tests (per Testing BLESS-B1/B2/B3, with explicit shapes)

**Test 1 — multi-message_end load-bearing test (Testing B1)**:

```typescript
test("intermediate message_end events do NOT trigger termination — only prompt() resolution does", async () => {
  const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
  await waitFor(() => session.promptCalls.length > 0);
  expect(h.taskState.get().kind).toBe("running");

  // Fire 5 message_end events matching pi-mono's actual per-turn behavior:
  session.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "x" }] }});
  session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "tool_call", tool: "bash" }] }});
  session.emit({ type: "message_end", message: { role: "tool", content: [{ type: "text", text: "ok" }] }});
  session.emit({ type: "message_end", message: { role: "assistant", content: [] }});
  session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] }});

  // CRITICAL: state must STILL be running. NOT completed.
  expect(h.taskState.get().kind).toBe("running");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  let lines = readAuditLines(...);
  expect(lines.filter((e) => e.event === "task_completed")).toHaveLength(0);

  // NOW resolve the prompt — canonical terminal signal.
  session.resolveCurrentPrompt!();
  await inflight;

  await waitFor(() => readAuditLines(...).filter((e) => e.event === "task_completed").length === 1);
  expect(h.taskState.get().kind).toBe("idle");  // cyclicity check
});
```

**Test 2 — duration_ms realism (Testing B2 + Obs S2)**:

```typescript
test("task_completed duration_ms reflects actual prompt() wall-clock, not subscriber-event arrival time", async () => {
  let nowMs = 1_000_000;
  const mgr = new SessionManager({ ...harness, now: () => nowMs });
  await mgr.init();

  const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
  await waitFor(() => session.promptCalls.length > 0);

  // Intermediate events at +7ms (the v0.2.1 smoking gun).
  nowMs += 7;
  session.emit({ type: "message_end", message: { role: "assistant", content: [] }});
  await new Promise((r) => setImmediate(r));

  // Real inference takes 2 seconds.
  nowMs += 2000;
  session.resolveCurrentPrompt!();
  await inflight;

  const completed = readAuditLines(...).find((e) => e.event === "task_completed")!;
  expect(completed.duration_ms).toBeGreaterThanOrEqual(2000);
  expect(completed.duration_ms).not.toBe(7);

  // Defense-in-depth: should NOT have fired the suspiciously_fast alarm.
  const fastAlarms = readAuditLines(...).filter((e) => e.event === "task_completed_suspiciously_fast");
  expect(fastAlarms).toHaveLength(0);
});
```

**Test 3 — task_completed_suspiciously_fast fires when duration_ms < 100ms (Obs W1)**:

```typescript
test("task_completed_suspiciously_fast audit fires when duration_ms < 100ms — catches v0.2.1 bug regression", async () => {
  let nowMs = 1_000_000;
  // Configure mock: prompt() resolves in 50ms.
  const inflight = mgr.handleInbound({ channel: "telegram", text: "x" });
  await waitFor(() => session.promptCalls.length > 0);
  nowMs += 50;
  session.resolveCurrentPrompt!();
  await inflight;

  const fast = readAuditLines(...).find((e) => e.event === "task_completed_suspiciously_fast");
  expect(fast).toBeDefined();
  expect(fast!.duration_ms).toBe(50);
});
```

**Test 4 — N=10 sequential inbounds all complete (Testing B3)**:

```typescript
test("N=10 sequential inbounds all complete: cyclicity survives across many turns", async () => {
  for (let i = 0; i < 10; i++) {
    const inflight = mgr.handleInbound({ channel: "telegram", text: `msg ${i}` });
    await waitFor(() => session.promptCalls.length === i + 1);
    expect(h.taskState.get().kind).toBe("running");
    session.resolveCurrentPrompt!();
    await inflight;
    expect(h.taskState.get().kind).toBe("idle");
  }
  const lines = readAuditLines(...);
  expect(lines.filter((e) => e.event === "task_started")).toHaveLength(10);
  expect(lines.filter((e) => e.event === "task_completed")).toHaveLength(10);
  expect(lines.filter((e) => e.event === "task_state_cas_failed")).toHaveLength(0);
});
```

**Test 5 — Mixed N=10 (throws + successes) cyclicity**:

```typescript
test("mixed N=10 (throws + successes) all reach a terminal state, NO silent drops", async () => {
  // Even iterations succeed, odd throw.
  // Assert: 10 task_started, 5 task_completed, 5 task_failed, 0 task_state_cas_failed.
});
```

**Test 6 — Production-replay (regression trap, per Testing S1)**:

```typescript
describe("production regression: MIB-2026-05-03-2336", () => {
  test("3 sequential inbounds all complete with realistic duration_ms (smoking gun: duration=7)", async () => {
    // Reproduces the Qwen3.6-35B-A3B 23:36 transcript:
    //   msg1 "say only: i am terminator" → reply
    //   msg2 "say now: im snow white"   → was silently dropped pre-v0.2.2
    //   msg3 "again?"                    → was silently dropped pre-v0.2.2
    // ... fire 3 inbounds + assert ALL 3 produce reply events on telegram sink
    // AND ALL 3 task_completed audit rows have duration_ms ≥ 100ms (not 7ms).
  });
});
```

**Test 7 — task_state_cas_failed audit type-safety (Adversarial B1)**:

```typescript
test("task_state_cas_failed audit row passes zod schema validation (no undefined fields)", async () => {
  // Trigger a CAS failure path; assert the audit row was actually appended
  // (i.e., zod parse succeeded — no silent rejection).
});
```

**Test 8 — restoreFromDisk handles terminal states with recovery info (Adversarial B4)**:

```typescript
test("restoreFromDisk reads completed/failed state and emits task_state_recovered_on_restart", async () => {
  // Pre-populate disk with completed state.
  // Restart; assert idle in memory + recovered audit row emitted.
});
```

**Test 9 — handleInbound terminal-state cyclicity-normalize (the MIB §3 silent-drop regression)**:

```typescript
test("inbound after stuck-in-completed: cyclicity guard recovers + new task_started fires", async () => {
  // Force state to completed (bypassing markTerminalAndIdle for test).
  // Send inbound; assert task_started audit + reply.
});
```

### A.7 — Verify

```bash
cd /Users/psergionicholas/Desktop/Cosas/personal/pi-local-llm-provider
npx tsc --noEmit
npx vitest run tests/session.test.ts tests/lib/task-state.test.ts
```

### A.8 — Commits

V2-A-1: TaskState `markTerminalAndIdle` primitive + flush + restoreFromDisk update + tests
V2-A-2: SessionManager refactor (extract helpers + use new primitive + drop subscriber-based termination)
V2-A-3: task_completed_suspiciously_fast alarm + audit schema additions + final tests

---

## IMPL-V2-B — Channel-side observability (NO content)

### B.1 — Promote `telegram_inbound` debug → info, NO CONTENT

**File**: `src/channels/telegram.ts`

Per Security BLESS-B1: the audit row + operator log line MUST contain ONLY:
- `event`, `ts`, `channel` (schema-required)
- `sender_id_hash` (salted via `AuditLog.senderIdHash` per Security BLESS-W1 — do NOT use the existing weak `hashSenderId`)
- `extra: { message_type: "text" | "voice" | "image" | "document" }`

MUST NOT contain: `text`, `inbound_msg_hash`, raw sender id, any preview.

### B.2 — Same for `whatsapp_inbound`

### B.3 — Verify `inbound_rate_limited` (do NOT add — Integration W1 + Obs W3)

Already exists at `src/audit/schema.ts:91`. Already emitted at `src/channels/telegram.ts:441-447` and `src/channels/whatsapp.ts:925-931`. ONLY task: verify tests cover; add if missing.

Plus: per Security BLESS-W1, swap weak `hashSenderId` for salted `AuditLog.senderIdHash` — daemon hands the function down through channel constructors.

---

## IMPL-V2-C — Daemon cancel paths + docs + diagnostic banner

### C.1 — Enumerate `tryTransition({kind: "cancelled"})` call sites

Search `src/daemon.ts` + `src/ipc/server.ts`. Each cancel path uses `taskState.markTerminalAndIdle({kind: "cancelled", ...})` instead of bare CAS.

### C.2 — Diagnostic-mode hint in startup banner

**File**: `src/utils/operator-logger.ts` (around the existing banner ~line 188-191)

Add footer line:
```
│ tip: OPERATOR_LOG_LEVEL=debug for diagnostic mode             │
```

Per UX BLESS-W6 + Obs BLESS-W8 convergence.

### C.3 — `docs/INSTALL.md` Diagnostic mode section with Security 4-point caveat

Per Security BLESS-B4 — full text including:
1. Volume increase warning
2. Content surface caveat (NEVER combine OPERATOR_LOG_LEVEL=debug + OPERATOR_LOG_CONTENT=true on shared boxes)
3. Sender hash exposure note
4. Audit-log volume note

### C.4 — `README.md` one-line cross-reference

"If something seems broken, see [Diagnostic mode](docs/INSTALL.md#diagnostic-mode)."

### C.5 — `SECURITY.md` new R-row

Per Security BLESS-B3:

```
### R31 — Lock-hold-time DoS surface (post-v0.2.2)

Pre-v0.2.2: the GlobalQueue lock released in ~7ms per request due to the
premature-termination bug. Post-v0.2.2: lock holds for full inference
duration (5-30s typical). An attacker who can trigger a tool-loop pattern
via prompt-injection through the watchdog reset (tool_execution_start
extends the deadline) can hold the queue indefinitely.

Mitigation today: 5min watchdog default + serial_queue_blocked notice + 
per-channel cooldown limit operator-visible spam.

v0.3 followup: per-prompt hard ceiling (taskMaxDurationMs config) that
overrides watchdog reset semantics for truly long single tasks.
```

---

# Phase B — Verification gates

After Wave 1: `npx tsc --noEmit && npx vitest run` — green modulo pre-existing 7 platform-specific Windows skips.

After Audit Wave: address every BLOCKER finding before final commit.

After BLESS Round: ship.

Sergio's smoke (Windows post-pull):

1. 5 messages with 3-second gaps → ALL 5 get individual replies; audit shows 5 task_started + 5 task_completed with realistic duration_ms (≥50ms each). NO `task_completed_suspiciously_fast` events. NO `pi_stuck_suspected` events (per Obs W7 — confirms pi-ping touches mid-stream now work).
2. 10 messages all at once → 1 gets reply + 9 get either `pi: still working...` notice (cooldown allows max 1 per 30s/channel) OR queue serially. NO silent drops.
3. **NEW**: send 5 messages with 1-second gaps → check audit log for `pi_stuck_suspected` events; should be ZERO (per Obs BLESS-W7 verification gate).

---

# Pitfalls Catalog (final)

| # | Pitfall | Mitigation |
|---|---|---|
| P1 | Choice D breaks if pi-mono's prompt() doesn't wait | **VERIFIED from agent.js source** — see Architectural foundation. No longer a hypothetical. |
| P2 | Backgrounded → completed → idle race vs auto-promote | markTerminalAndIdle's CAS allows running→completed AND backgrounded→completed |
| P3 | Cyclicity guard fires unexpectedly | Logs at debug level (per emitCasFailure logic); audit only on truly inconsistent transitions |
| P4 | `reply` ChannelEvent fires before state transitions to completed | Sink fan-out is async; user perceives correct sequence (reply lands, then if quick follow-up, busy notice fires correctly) |
| P5 | S4 task_completed rewrite reads state at fan-out time | rewrite still works post-v0.2.2 because state is `backgrounded` until `await prompt()` returns; rewrite happens during streaming |
| P6 | Promoting telegram_inbound to info doubles operator-log volume | Acceptable; v0.3 followup for sampling. **No content fields ever in this row** (Security BLESS-B1) |
| P7 | task_state_cas_failed audit might fire spuriously during shutdown | Best-effort `.catch()`; demoted to debug for terminal-CAS races (Adversarial W2 + PE S2) |
| P8 | Test refactor in A.6 might leave dead test cases | Delete outright; new contract tests are explicit and exhaustive |
| P9 | Audit-log volume increases ~50-70% post-v0.2.2 | Document in v0.2.2 followups; existing 90-day purge handles |
| P10 | DoS lock-hold time increases | Documented in SECURITY.md R31; v0.3 followup for taskMaxDurationMs |
| P11 | Operator log has no retention | Document; v0.3 followup |
| P12 | task_completed_suspiciously_fast threshold (100ms) might fire on legit fast turns | gemma-2B at warm cache produces ≥50ms replies; threshold is conservative; revisit if false positives |

---

# Out of Scope (deferred)

- **`taskMaxDurationMs` config** for DoS hardening — v0.3
- **Per-channel inbound log sampling** — v0.3 if volume becomes a concern
- **Operator-log retention/purge** — v0.3
- **`pi-comms doctor` self-diagnostic command** — v0.3 (Obs S1)
- **Salted senderIdHash propagation through channel constructors** — could be in v0.2.2 IMPL-V2-B as a small addition, OR v0.3
- **Hard model swap** — v5
- **`/consult` and `/setup-comms`** — v5

---

# Multi-elder convergence index (for traceability)

| Finding | Elders | v0.2.2 disposition |
|---|---|---|
| handleInbound too large; extract helpers | Architect W1 + PE W1 + Integration | LANDED — normalizeTerminalState + emitCasFailure |
| Operator-log retention concern | PE W3 + Obs W4 + Sec B4 | DEFERRED to v0.3 (documented) |
| task_state_cas_failed needs prior task_id | DG S2 + Obs W2 + Architect | LANDED — `stuck_task_id` in extra |
| Multi-message_end test required | Testing B1 + Architect S4 + Obs S2 | LANDED — Test 1 in A.6 |
| Diagnostic-mode discoverability via banner | UX W6 + Obs W8 | LANDED — IMPL-V2-C C.2 |
| Demote terminal-CAS races to debug | Adversarial W2 + PE S2 | LANDED — emitCasFailure logic |
| Atomic markTerminalAndIdle in TaskState | Architect B2 + DG B1 | LANDED — IMPL-V2-A A.1 |
| User notice on CAS-to-running failure | UX W7 + (PE related) | LANDED — handleInbound emitUserFacingNotice |
| Watchdog → idle transition | Architect W2 + Adversarial B6 | LANDED — uses markTerminalAndIdle |
| Cancel paths → idle transition | Adversarial B6 + Integration W2 | LANDED — IMPL-V2-C C.1 |
| inbound_rate_limited already exists | Integration W1 + Obs W3 | NO ADD — verify only |
| restoreFromDisk recovery for terminal states | Adversarial B4 + PE B1 | LANDED — task_state_recovered_on_restart |
| audit `extra.reason` zod-safety | Adversarial B1 + Security B2 | LANDED — `?? "unknown"` + comment forbidding user content |
| Try/finally for post-prompt cleanup | Integration W4 + PE W2 | LANDED — finally block |
| Adversarial re-bless NEW-1 (idle→terminal cancel-race) | Adversarial v2 NEW-1 | LANDED in v2.1 — TERMINAL_RACE_KINDS expanded to include "idle" |
| Adversarial re-bless NEW-2 (missing audit event) | Adversarial v2 NEW-2 | LANDED in v2.1 — task_state_recovered_on_restart added to schema additions |
| Adversarial re-bless NEW-3 (security error_class) | Adversarial v2 NEW-3 | LANDED in v2.1 — explicit comment in §A.3 |
| Adversarial re-bless NEW-4 (RestoreResult priorState) | Adversarial v2 NEW-4 | LANDED in v2.1 — preserved priorState field |
| Adversarial re-bless NEW-5 (flush dup) | Adversarial v2 NEW-5 | LANDED in v2.1 — use existing flush, don't duplicate |
| Adversarial re-bless NEW-6 (explicit subscriber deletion checklist) | Adversarial v2 NEW-6 | LANDED in v2.1 — 6-step checklist in §A.4 |
| Adversarial re-bless NEW-7 (drop ipc/server.ts) | Adversarial v2 NEW-7 | LANDED in v2.1 — Files Touched table updated |
| Adversarial re-bless NEW-8 (RecoveredTaskInfo def) | Adversarial v2 NEW-8 | LANDED in v2.1 — interface defined |

---

*Plan v2.1 frozen. Adversarial re-bless completed; 3 BLOCKERS + 5 NITs from re-bless folded in. Ready for Wave 1 dispatch.*
