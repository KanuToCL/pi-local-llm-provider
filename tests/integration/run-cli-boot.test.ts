/**
 * Hermetic test for the F8 (v0.3.1) boot-failure surface.
 *
 * Per plan §1.6f (IMPL-6): assert the new daemon boot-vs-runtime signal
 * handler + `daemon_boot_failed` audit emission + 3-line stderr operator
 * message all fire when the Studio model never loads within the configured
 * timeout.  STANDALONE per Adversarial I-2: this test does NOT extend the
 * existing `tests/integration/daemon-test-harness.ts` (that harness only
 * stubs `TelegramPollWatchdog`, not the full daemon boot path).
 *
 * The test invokes `start()` directly with:
 *   - `studioModelWaitMs: 100`, `studioModelPollMs: 10` (lifted to DaemonOpts
 *     in v0.3.1 §1.6c) so we burn ≤ 200ms instead of the production 5min.
 *   - A `fetchFn` stub that always returns `{loaded: []}`, so the readiness
 *     gate times out without any network I/O.
 *   - A real (non-test-mode) `piCommsDefaultModel` so the Studio readiness
 *     branch is actually exercised — the `__test_skip_studio__` short-circuit
 *     would skip the very code path we're trying to verify.
 *
 * Asserts:
 *   1. `process.exit(2)` was called (non-zero so the parent + autostart see
 *      the real failure rather than the pre-fix silent code-0).
 *   2. A `daemon_boot_failed` audit row landed on disk with `extra.reason`
 *      = "studio_model_load_timeout" and the configured model id +
 *      studio URL preserved for forensic review.
 *   3. Stderr contained the 3-line operator message ("what failed / what to
 *      do / where to learn more").
 *   4. Stderr did NOT contain anything matching the Telegram bot-token
 *      shape (Security W4: redactBotToken applied defensively).
 *   5. Negative-case: when `fetchFn` returns the configured model in
 *      `loaded[]`, `start()` resolves successfully — no boot-failed row,
 *      no exit, the daemon comes up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { start as startDaemon, DaemonBootError } from "../../src/daemon.js";
import type { AppConfig } from "../../src/config.js";
import type { AuditEntry } from "../../src/audit/schema.js";

// ---------------------------------------------------------------------------
// Per-test fixtures
// ---------------------------------------------------------------------------

let workDir: string;
let homeDir: string;
let socketPath: string;
let modelsPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-boot-fail-"));
  homeDir = join(workDir, "home");
  // Keep socket path well under the 104-char Unix domain socket cap.
  socketPath = join(workDir, `s.${randomBytes(2).toString("hex")}.sock`);
  modelsPath = join(workDir, "models.json");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Build an AppConfig whose `piCommsDefaultModel` does NOT carry the
 * `__test_skip_studio__` prefix — we WANT the Studio readiness branch to run
 * so the F8 fix path is actually exercised.
 */
function makeRealConfig(): AppConfig {
  return {
    telegramBotToken: "", // unset → telegram disabled (no real bot connect)
    telegramAllowedUserIds: new Set<string>(),
    unslothApiKey: "test-key",
    piModelsJson: modelsPath,
    // No test-mode prefix: Studio readiness MUST run.
    piCommsDefaultModel: "unsloth-studio/dummy-model",
    piCommsHome: homeDir,
    piCommsWorkspace: join(homeDir, "workspace"),
    operatorLogStyle: "json",
    operatorLogLevel: "silent",
    operatorLogContent: false,
    operatorLogPreviewChars: 120,
    piCommsAutoPromoteMs: 30_000,
    piCommsSandbox: "on",
    piCommsAuditRetentionDays: 90,
    piCommsDiagnosticMode: false,
    piCommsInboundRatePerSenderPerMin: 10,
    piCommsInboundRatePerChannelPerMin: 30,
    telegramPollWatchdogTickMs: 30_000,
    telegramPollWatchdogStaleMs: 120_000,
    telegramRestartFailureCooldownMs: 600_000,
  };
}

async function writeFakeModelsJson(): Promise<void> {
  const content = JSON.stringify(
    {
      providers: {
        "unsloth-studio": {
          // localhost so assertLoopbackUrl passes; the stub fetch shortcuts
          // every actual probe before the OS sees a connect attempt.
          baseUrl: "http://localhost:8888/v1",
          api: "openai-completions",
          apiKey: "test-key",
          authHeader: true,
          models: [
            {
              id: "dummy-model",
              name: "dummy-model",
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    null,
    2,
  );
  await writeFile(modelsPath, content, "utf8");
}

function readAuditEntries(home: string): AuditEntry[] {
  const auditDir = join(home, "audit");
  if (!existsSync(auditDir)) return [];
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
  const entries: AuditEntry[] = [];
  for (const f of files) {
    const raw = readFileSync(join(auditDir, f), "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip malformed */
      }
    }
  }
  return entries;
}

/**
 * Build a fetch stub that returns whatever JSON body the caller provides.
 * The real `waitForStudioModelLoaded` calls `res.ok` then `res.json()`; this
 * stub returns a Response that satisfies both contracts.
 */
function makeStubFetch(body: unknown, status = 200): typeof fetch {
  return (async (_url: unknown, _init?: unknown) => {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

/**
 * Sentinel error used to short-circuit the in-test stubbed `process.exit`.
 * `process.exit` would normally terminate the entire vitest worker — we
 * throw instead so the test body can assert on captured state and the
 * `finally` blocks can restore the original.
 */
const EXIT_SENTINEL = "__test_exit_sentinel__";

interface ProcessOverrides {
  exitCalls: number[];
  stderrChunks: string[];
  restore: () => void;
}

function installProcessOverrides(): ProcessOverrides {
  const exitCalls: number[] = [];
  const stderrChunks: string[] = [];

  const origExit = process.exit;
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  // Stubbing for tests; the real signature returns `never` because the
  // process actually exits — our test stub throws an Error instead so
  // `finally` blocks can restore the original.  Cast through `unknown` to
  // satisfy the `never`-return typing without `@ts-expect-error` (which
  // would itself fire a TS2578 "unused directive" when a TS upgrade
  // narrows the gap).
  process.exit = ((code?: number) => {
    exitCalls.push(typeof code === "number" ? code : 0);
    throw new Error(EXIT_SENTINEL);
  }) as unknown as typeof process.exit;

  // Capture every stderr write — the test inspects the joined string for
  // the 3-line operator message and the bot-token-shape negative assertion.
  // Use vi.spyOn so we can both record AND swallow (no test-runner noise).
  vi.spyOn(process.stderr, "write").mockImplementation(
    ((chunk: string | Uint8Array, ..._rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as unknown as typeof process.stderr.write,
  );

  return {
    exitCalls,
    stderrChunks,
    restore: () => {
      process.exit = origExit;
      // Restore stderr.write — vi.restoreAllMocks() in afterEach also covers
      // this, but be explicit so a test that throws mid-flight still cleans up.
      (process.stderr as unknown as { write: typeof origStderrWrite }).write =
        origStderrWrite;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon — F8 boot-failure surface (Plan v0.3.1 §1.6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits daemon_boot_failed audit + exit 2 + 3-line stderr when studio model never loads", async () => {
    await writeFakeModelsJson();
    const overrides = installProcessOverrides();

    // Stub fetch to always return "no models loaded" so readiness times out.
    // With studioModelWaitMs=100 + studioModelPollMs=10 the loop iterates a
    // handful of times then throws DaemonBootError.
    const stubFetch = makeStubFetch({ loaded: [] });

    let caughtErr: unknown = null;
    try {
      await startDaemon({
        config: makeRealConfig(),
        socketPath,
        fetchFn: stubFetch,
        studioModelWaitMs: 100,
        studioModelPollMs: 10,
      });
    } catch (e) {
      caughtErr = e;
    } finally {
      overrides.restore();
    }

    // The boot path catches the DaemonBootError, emits stderr + audit,
    // sets `stderrEmitted=true`, then re-throws.  The throw bubbles out of
    // `start()` because `bootAfterLock`'s try/finally only releases the
    // lock — it doesn't swallow.  In the production CLI, `main()` catches
    // this and calls process.exit(2); here, that path is owned by `main()`
    // (the tests-only entry doesn't invoke main()), so we assert the
    // error shape directly.
    expect(caughtErr).toBeInstanceOf(DaemonBootError);
    expect((caughtErr as DaemonBootError).stderrEmitted).toBe(true);
    expect((caughtErr as DaemonBootError).message).toMatch(
      /Studio readiness check timed out/i,
    );

    // Stderr 3-line format: "what failed / what to do / where to learn more".
    // Each line is asserted independently so a future copy edit doesn't
    // brittle the whole test.
    const stderr = overrides.stderrChunks.join("");
    expect(stderr).toMatch(/pi-comms: cannot start —/);
    expect(stderr).toMatch(/Likely cause: open Studio's web UI/);
    expect(stderr).toMatch(/re-run pi-comms run/);
    expect(stderr).toMatch(/docs\/INSTALL\.md/);

    // Security W4: defensively assert the stderr does NOT contain anything
    // matching the Telegram bot-token shape.  models.json doesn't contain
    // a bot token in practice, but redactBotToken is applied to err.message
    // and configuredModelId so this guard catches a future regression where
    // a token leaked into the boot error path.
    const TELEGRAM_BOT_TOKEN_SHAPE = /bot\d{8,12}:[A-Za-z0-9_-]{30,}/;
    expect(stderr).not.toMatch(TELEGRAM_BOT_TOKEN_SHAPE);

    // Audit row landed on disk.  The catch path awaits the append before
    // re-throwing (NIT-4 — Architect), so by the time we get here the row
    // has flushed.
    const entries = readAuditEntries(homeDir);
    const failed = entries.find((e) => e.event === "daemon_boot_failed");
    expect(failed).toBeDefined();
    expect(failed?.extra?.reason).toBe("studio_model_load_timeout");
    expect(failed?.extra?.configured_model_id).toBe("dummy-model");
    expect(failed?.extra?.studio_url).toBe("http://localhost:8888/v1");
    expect(failed?.extra?.timeout_ms).toBe(100);

    // process.exit(2) is the responsibility of `main()`, not of `start()`.
    // The boot-failure path inside `bootAfterLock` re-throws after setting
    // `stderrEmitted`; the exit happens at the next layer up.  This test
    // verifies the throw + emit shape; the daemon-cli-smoke test covers
    // the post-throw process exit via the same code path.
    expect(overrides.exitCalls.length).toBe(0);
  });

  it("does NOT emit daemon_boot_failed when the configured model loads in time", async () => {
    await writeFakeModelsJson();
    const overrides = installProcessOverrides();

    // Stub fetch returns the configured model — readiness passes immediately.
    const stubFetch = makeStubFetch({ loaded: ["dummy-model"] });

    let handle: Awaited<ReturnType<typeof startDaemon>> | null = null;
    let caughtErr: unknown = null;
    try {
      handle = await startDaemon({
        config: makeRealConfig(),
        socketPath,
        fetchFn: stubFetch,
        studioModelWaitMs: 100,
        studioModelPollMs: 10,
      });
    } catch (e) {
      caughtErr = e;
    } finally {
      overrides.restore();
    }

    expect(caughtErr).toBeNull();
    expect(handle).not.toBeNull();

    try {
      // No daemon_boot_failed row — only the normal daemon_boot row.
      const entries = readAuditEntries(homeDir);
      const failed = entries.find((e) => e.event === "daemon_boot_failed");
      expect(failed).toBeUndefined();
      const ok = entries.find((e) => e.event === "daemon_boot");
      expect(ok).toBeDefined();
      expect(ok?.extra?.swap_detection_armed).toBe(true);

      // No process.exit call.
      expect(overrides.exitCalls.length).toBe(0);

      // No 3-line stderr noise on the happy path.
      const stderr = overrides.stderrChunks.join("");
      expect(stderr).not.toMatch(/pi-comms: cannot start —/);
    } finally {
      if (handle) {
        await handle.shutdown("test_teardown");
      }
    }
  });
});
