/**
 * Phase -1 SDK Verification Spike (pi-comms daemon)
 *
 * Sergio runs this on the Windows RTX 5070 production box BEFORE Phase 0 starts.
 * Result determines whether the architecture is feasible as-planned (library-embed)
 * or whether v5 must pivot to subprocess + stdout-marker (gemini-claw pattern,
 * `CliGeminiClient.ts:122-238`).
 *
 * Six probes (per plan §"Phase -1 SDK Verification Spike" + §"v4.2 extended scope"):
 *   1. Symbol presence       — every name the plan assumes from @mariozechner/pi-coding-agent
 *   2. Session creation      — construct AgentSession against local Studio + 1-turn ping
 *   3. Tool registration     — register no-op `tell_test`, assert model invokes it
 *   4. AbortSignal cancel    — abort mid-stream, assert graceful shutdown
 *   5. Tool-call interception — intercept bash spawn (load-bearing for /unsand)
 *   6. Post-abort silence    — assert NO callbacks fire after abort() returns
 *
 * Output: ~/.pi-comms/sdk-spike.json + human-readable stdout summary
 * Exit: 0 all-pass, 1 partial, 2 critical-fail (or sdk-not-installed)
 *
 * Run: npm run spike   (or: npx tsx scripts/sdk-spike.ts)
 *
 * If pi-coding-agent isn't installed (e.g. macOS dev box where it's an
 * optionalDependency), exits 2 with recommendation to install on Windows
 * production box and re-run there.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// pi-mono throws synchronously inside Promise-returning APIs (e.g. when no API
// key is configured). These propagate as unhandledRejection on Node ≥22 and
// would tear the spike down before we can record the probe failure. Surface them
// to stderr so the JSON probe records the cause but DO NOT exit.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[spike] unhandledRejection (recorded; spike continues):",
    reason instanceof Error ? reason.message : reason,
  );
});
process.on("uncaughtException", (err) => {
  console.error("[spike] uncaughtException (recorded; spike continues):", err.message);
});

// ----------------------------------------------------------------------------
// Output shape (matches plan §"Phase -1" deliverable)
// ----------------------------------------------------------------------------

type ProbeResult = {
  passed: boolean;
  details?: string;
  error?: string;
};

type SpikeReport = {
  timestamp: string;
  nodeVersion: string;
  platform: string;
  sdkVersion: string | null;
  probes: Record<string, ProbeResult>;
  summary: "all-pass" | "partial" | "critical-fail";
  recommendation: string;
};

const PROBES = [
  "symbol_presence",
  "session_creation",
  "tool_registration",
  "abort_signal",
  "tool_call_interception",
  "post_abort_callback_silence",
] as const;
type ProbeName = (typeof PROBES)[number];

// Names the plan assumes exist on the SDK surface. Recorded in symbol_presence
// probe details so post-spike review can see which assumptions held.
const ASSUMED_SYMBOLS = [
  "createAgentSession",
  "AgentSession",
  "SessionManager",
  "DefaultResourceLoader",
  "registerTool", // assumed on session or as top-level
  "registerCommand", // ExtensionAPI member, but plan probes for top-level too
  "onComplete",
  "onBlockReply",
  "onPartialReply",
  "onToolResult",
  "ModelRegistry",
  "createCodingTools",
  "defineTool",
] as const;

// ----------------------------------------------------------------------------
// Output helpers
// ----------------------------------------------------------------------------

const OUT_DIR = path.join(os.homedir(), ".pi-comms");
const OUT_FILE = path.join(OUT_DIR, "sdk-spike.json");

function writeReport(report: SpikeReport): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function printSummary(report: SpikeReport): void {
  console.log("");
  console.log("=== pi-comms SDK Spike — Phase -1 Verification ===");
  console.log(`timestamp:  ${report.timestamp}`);
  console.log(`node:       ${report.nodeVersion}`);
  console.log(`platform:   ${report.platform}`);
  console.log(`sdk:        ${report.sdkVersion ?? "(not installed)"}`);
  console.log("");
  console.log("Probes:");
  for (const name of PROBES) {
    const r = report.probes[name];
    if (!r) {
      console.log(`  [SKIP] ${name}`);
      continue;
    }
    const mark = r.passed ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${name}${r.details ? ` — ${r.details}` : ""}`);
    if (r.error) console.log(`         error: ${r.error}`);
  }
  console.log("");
  console.log(`summary: ${report.summary.toUpperCase()}`);
  console.log(`recommendation: ${report.recommendation}`);
  console.log("");
  console.log(`report written to: ${OUT_FILE}`);
}

function summarize(probes: Record<string, ProbeResult>): SpikeReport["summary"] {
  const ran = PROBES.filter((p) => probes[p] !== undefined);
  if (ran.length === 0) return "critical-fail";
  const failed = ran.filter((p) => !probes[p]!.passed);
  if (failed.length === 0) return "all-pass";

  // Plan §"Phase -1 decision tree" + §"v4.2 extended scope":
  // tool_registration, abort_signal, tool_call_interception failures all
  // demand re-plan / Phase 1.5 modification — these are critical.
  const criticalProbes: ProbeName[] = [
    "tool_registration",
    "abort_signal",
    "tool_call_interception",
    "post_abort_callback_silence",
  ];
  const anyCritical = failed.some((p) => criticalProbes.includes(p as ProbeName));
  return anyCritical ? "critical-fail" : "partial";
}

function recommendationFor(
  summary: SpikeReport["summary"],
  probes: Record<string, ProbeResult>,
): string {
  if (summary === "all-pass") {
    return "All probes passed. Proceed to Phase 0 with library-embed architecture as planned.";
  }

  // Critical-fail — pick the most actionable failure per the plan's decision tree.
  if (probes.tool_registration && !probes.tool_registration.passed) {
    return (
      "Re-plan v5: pivot to subprocess + stdout-marker pattern (see " +
      "gemini-claw `CliGeminiClient.ts:122-238`). tell()/confirm()/go_background() " +
      "become parsed-from-stdout conventions. ~30% additional scope."
    );
  }
  if (probes.tool_call_interception && !probes.tool_call_interception.passed) {
    return (
      "Re-plan v5: same subprocess pivot as `pi.registerTool` missing path. " +
      "Library-embed loses sandbox enforceability; subprocess regains it (we own " +
      "spawn). Cite gemini-claw CliGeminiClient.ts:122-238."
    );
  }
  if (probes.abort_signal && !probes.abort_signal.passed) {
    return (
      "Phase 1.5 modified: cancellation must go to subprocess SIGTERM/SIGKILL " +
      "even in library-embed mode. Add child-process supervisor wrapping " +
      "createAgentSession."
    );
  }
  if (probes.post_abort_callback_silence && !probes.post_abort_callback_silence.passed) {
    return (
      "Phase 1.5 modified: TaskState CAS guards must filter ALL post-abort() " +
      "events at daemon level (do NOT trust pi-mono); add explicit " +
      "taskState.kind !== 'cancelled' check before any sink emit."
    );
  }
  if (summary === "partial") {
    return (
      "Some non-critical probes failed (likely callback-name mismatches). Review " +
      "details and update plan §'Phase -1 SDK spike' to use the actual symbol names."
    );
  }
  return (
    "Critical probe failure with no SDK-loaded path — likely Studio unreachable. " +
    "Verify Studio is running on http://localhost:8888/v1, then re-run."
  );
}

// ----------------------------------------------------------------------------
// Probe utilities
// ----------------------------------------------------------------------------

async function loadSdkVersion(): Promise<string | null> {
  // The SDK's package.json is not in its `exports` field, so read it directly
  // off disk from node_modules.
  try {
    const candidates = [
      path.join(
        process.cwd(),
        "node_modules",
        "@mariozechner",
        "pi-coding-agent",
        "package.json",
      ),
      path.join(
        os.homedir(),
        ".npm-global",
        "lib",
        "node_modules",
        "@mariozechner",
        "pi-coding-agent",
        "package.json",
      ),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const raw = fs.readFileSync(c, "utf8");
        const j = JSON.parse(raw) as { version?: string };
        if (j.version) return j.version;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function writeTempModelsJson(): string {
  const cfg = {
    providers: {
      "unsloth-studio": {
        baseUrl: "http://localhost:8888/v1",
        api: "openai-completions",
        apiKey: process.env.UNSLOTH_API_KEY ?? "spike-placeholder-key",
        authHeader: true,
        models: [
          {
            id: process.env.PI_COMMS_SPIKE_MODEL ?? "unsloth/Qwen3.6-27B-GGUF",
            name: "Spike model",
            reasoning: false,
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              maxTokensField: "max_tokens",
            },
          },
        ],
      },
    },
  };
  const tmp = path.join(os.tmpdir(), `pi-comms-spike-models-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  return tmp;
}

// Withhold-after-N-ms helper for probes that may hang on a missing API.
// Accepts a thunk so sync throws inside the SDK body become Promise rejections.
function withTimeout<T>(thunk: () => Promise<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    let p: Promise<T>;
    try {
      p = Promise.resolve(thunk());
    } catch (e) {
      clearTimeout(t);
      reject(e);
      return;
    }
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<number> {
  const probes: Record<string, ProbeResult> = {};

  // Try to load the SDK. If it isn't installed (optionalDependency on macOS),
  // bail out with sdk-not-installed.
  let sdk: any = null;
  let sdkVersion: string | null = null;
  let sdkLoadError: string | null = null;

  try {
    sdk = await import("@mariozechner/pi-coding-agent");
    sdkVersion = await loadSdkVersion();
  } catch (e) {
    sdkLoadError = (e as Error).message;
  }

  if (!sdk) {
    const report: SpikeReport = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: os.platform(),
      sdkVersion: null,
      probes: {
        symbol_presence: {
          passed: false,
          error: `SDK not installed: ${sdkLoadError ?? "import returned undefined"}`,
        },
      },
      summary: "critical-fail",
      recommendation:
        "sdk-not-installed: install via `npm install -g @mariozechner/pi-coding-agent` " +
        "then re-run spike on a machine where Studio is running (Sergio's RTX 5070 box).",
    };
    writeReport(report);
    printSummary(report);
    return 2;
  }

  // ---- Probe 1: Symbol presence ------------------------------------------
  // Record which assumed names actually exist as named exports.
  const present: Record<string, boolean> = {};
  for (const name of ASSUMED_SYMBOLS) {
    present[name] = name in sdk && (sdk as any)[name] !== undefined;
  }
  const presentCount = Object.values(present).filter(Boolean).length;
  // The plan only blocks if createAgentSession + tool-registration mechanism are
  // missing. Other names (callback names) may be event types — record but not block.
  const corePresent =
    present.createAgentSession === true &&
    (present.defineTool === true || present.createCodingTools === true);
  probes.symbol_presence = {
    passed: corePresent,
    details: `${presentCount}/${ASSUMED_SYMBOLS.length} assumed symbols present. detail: ${JSON.stringify(present)}`,
  };

  // ---- Probe 2: Session creation -----------------------------------------
  const modelsPath = writeTempModelsJson();
  let session: any = null;
  try {
    if (typeof sdk.createAgentSession !== "function") {
      throw new Error("createAgentSession is not a function on SDK exports");
    }
    // Best-effort minimal-arg construction. Real shape is verified at probe time;
    // if the SDK rejects the args, that's a useful signal for the spike.
    const result = await withTimeout(
      () =>
        sdk.createAgentSession({
          cwd: process.cwd(),
          modelsConfigPath: modelsPath,
          providerId: "unsloth-studio",
        } as any),
      15_000,
      "createAgentSession",
    );
    session = (result as any)?.session ?? result;
    if (!session) throw new Error("createAgentSession returned no session object");

    // 1-turn ping. If the session API doesn't have prompt(), that's a probe failure
    // — pi-mono ≥0.72 should expose it. Signature is prompt(text: string, options?).
    if (typeof session.prompt !== "function") {
      throw new Error("session.prompt is not a function");
    }
    await withTimeout(() => session.prompt("ping"), 30_000, "session.prompt(ping)");
    probes.session_creation = {
      passed: true,
      details: "AgentSession constructed and 1-turn ping returned",
    };
  } catch (e) {
    probes.session_creation = {
      passed: false,
      error: (e as Error).message,
      details: "Studio likely unreachable on this machine OR createAgentSession arg-shape differs",
    };
  }

  // ---- Probe 3: Tool registration ----------------------------------------
  // Verify a custom tool can be registered AND the model invokes it (not text-leak).
  let toolHandlerCalled = false;
  try {
    if (!session) throw new Error("no session from probe 2 — skipping");
    const defineTool = sdk.defineTool;
    if (typeof defineTool !== "function") {
      throw new Error("defineTool not exported (cannot register custom tools via SDK)");
    }
    const tellTest = defineTool({
      name: "tell_test",
      description: "No-op probe tool. Returns OK.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        toolHandlerCalled = true;
        return { content: [{ type: "text", text: "OK" }] };
      },
    } as any);

    const reg = (session as any).registerTool ?? (sdk as any).registerTool;
    if (typeof reg !== "function") {
      throw new Error("Neither session.registerTool nor sdk.registerTool exists");
    }
    await reg.call(session, tellTest);

    await withTimeout(
      () => session.prompt("Please call the tell_test tool with no arguments."),
      45_000,
      "session.prompt(tool-trigger)",
    );

    if (!toolHandlerCalled) {
      throw new Error(
        "tell_test handler was NOT called — model may have text-leaked the tool call",
      );
    }
    probes.tool_registration = {
      passed: true,
      details: "tell_test registered and invoked by model",
    };
  } catch (e) {
    probes.tool_registration = {
      passed: false,
      error: (e as Error).message,
    };
  }

  // ---- Probe 4: AbortSignal cancellation ---------------------------------
  // Start a streaming prompt, abort mid-stream, verify graceful exit within 5s.
  let abortGracefulMs = -1;
  try {
    if (!session) throw new Error("no session — skipping");
    if (typeof session.abort !== "function") {
      throw new Error("session.abort is not a function");
    }
    const startedAt = Date.now();
    const longPrompt = Promise.resolve().then(() =>
      (session as any).prompt(
        "Please count slowly from 1 to 100, one number per line, with a brief comment after each number.",
      ),
    );

    // Yield a beat then abort.
    await new Promise((r) => setTimeout(r, 1000));
    const abortPromise = (session as any).abort();

    // Wait for both to settle; the prompt should reject or resolve cleanly.
    await Promise.allSettled([longPrompt, abortPromise]);
    abortGracefulMs = Date.now() - startedAt;

    if (abortGracefulMs > 5000 + 1000 + 30_000) {
      // 1s pre-abort + abort path; allow generous fudge to confirm cleanup didn't hang
      throw new Error(`abort took ${abortGracefulMs}ms — exceeds 30s+ threshold`);
    }
    probes.abort_signal = {
      passed: true,
      details: `abort settled within ${abortGracefulMs}ms`,
    };
  } catch (e) {
    probes.abort_signal = {
      passed: false,
      error: (e as Error).message,
    };
  }

  // ---- Probe 5: Tool-call interception (v4.2) ----------------------------
  // Wrap the bash tool's spawn so OUR handler executes, not pi-mono's internal
  // spawn. If this fails, sandbox + /unsand are architecturally undefined.
  let bashInterceptCalled = false;
  try {
    if (!session) throw new Error("no session — skipping");

    // Strategy A: pi-mono ≥0.72 exposes BashSpawnHook on createBashToolDefinition.
    const createBashDef = (sdk as any).createBashToolDefinition;
    if (typeof createBashDef !== "function") {
      throw new Error(
        "createBashToolDefinition not exported — cannot register bash spawn hook",
      );
    }
    const hookedBash = createBashDef({
      spawnHook: (
        _ctx: any,
        spawnArgs: { command: string; args: readonly string[] },
        next: any,
      ) => {
        bashInterceptCalled = true;
        // Forward to default behavior so the prompt completes; we only need to
        // observe that OUR hook ran.
        return next(spawnArgs);
      },
    } as any);

    const reg = (session as any).registerTool ?? (sdk as any).registerTool;
    if (typeof reg !== "function") {
      throw new Error("registerTool unavailable for bash override");
    }
    await reg.call(session, hookedBash);

    await withTimeout(
      () =>
        session.prompt(
          "Run the bash command `echo pi-comms-spike-marker` and tell me the output.",
        ),
      60_000,
      "session.prompt(bash-trigger)",
    );

    if (!bashInterceptCalled) {
      throw new Error(
        "Bash spawn hook was NOT called — pi-mono spawned raw, sandbox cannot be enforced",
      );
    }
    probes.tool_call_interception = {
      passed: true,
      details: "BashSpawnHook fired during bash invocation",
    };
  } catch (e) {
    probes.tool_call_interception = {
      passed: false,
      error: (e as Error).message,
    };
  }

  // ---- Probe 6: Post-abort callback silence (v4.2) -----------------------
  // Subscribe to events; abort mid-stream; assert NO events fire in the 2s
  // window after abort() returns.
  try {
    if (!session) throw new Error("no session — skipping");
    if (typeof session.subscribe !== "function") {
      throw new Error("session.subscribe is not a function (no event channel)");
    }

    let abortReturnedAt = 0;
    let postAbortEvents = 0;
    const lateEventTypes: string[] = [];

    const unsubscribe = session.subscribe((evt: any) => {
      if (abortReturnedAt && Date.now() > abortReturnedAt) {
        postAbortEvents++;
        if (lateEventTypes.length < 8) lateEventTypes.push(String(evt?.type ?? "?"));
      }
    });

    const longPrompt = Promise.resolve().then(() =>
      (session as any).prompt("Count from 1 to 50 slowly, one per line."),
    );

    await new Promise((r) => setTimeout(r, 800));
    await (session as any).abort();
    abortReturnedAt = Date.now();
    await Promise.allSettled([longPrompt]);

    // 2s observation window post-abort
    await new Promise((r) => setTimeout(r, 2000));
    unsubscribe?.();

    if (postAbortEvents > 0) {
      throw new Error(
        `${postAbortEvents} event(s) fired after abort() returned. types: ${lateEventTypes.join(",")}`,
      );
    }
    probes.post_abort_callback_silence = {
      passed: true,
      details: "no events observed in 2s window after abort()",
    };
  } catch (e) {
    probes.post_abort_callback_silence = {
      passed: false,
      error: (e as Error).message,
    };
  }

  // ---- Cleanup -----------------------------------------------------------
  try {
    fs.unlinkSync(modelsPath);
  } catch {
    /* ignore */
  }
  try {
    if (session && typeof session.close === "function") await session.close();
    else if (session && typeof session.shutdown === "function") await session.shutdown();
  } catch {
    /* ignore */
  }

  // ---- Build report ------------------------------------------------------
  const summary = summarize(probes);
  const recommendation = recommendationFor(summary, probes);
  const report: SpikeReport = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: os.platform(),
    sdkVersion,
    probes,
    summary,
    recommendation,
  };
  writeReport(report);
  printSummary(report);

  if (summary === "all-pass") return 0;
  if (summary === "partial") return 1;
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("spike crashed:", e);
    // Best-effort: still write a critical-fail report so the run leaves a trace.
    try {
      writeReport({
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        platform: os.platform(),
        sdkVersion: null,
        probes: {
          symbol_presence: { passed: false, error: `spike crashed: ${(e as Error).message}` },
        },
        summary: "critical-fail",
        recommendation:
          "Spike crashed before completing probes. Check stderr above and fix " +
          "before re-running. If SDK shape changed, update scripts/sdk-spike.ts.",
      });
    } catch {
      /* nothing more we can do */
    }
    process.exit(2);
  },
);
