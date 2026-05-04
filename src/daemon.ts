/**
 * pi-comms daemon — orchestrator.
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md:
 *   - §"Architecture (detailed)" / §"Three processes" (lines 62-117): the
 *     long-lived daemon owns the SINGLE shared AgentSession, the IPC server,
 *     all channel listeners, the audit log, the status pointer, and the
 *     dead-man heartbeat surface.
 *   - §"Daemon ↔ CLI IPC contract" (line 251): JSON-line socket at
 *     `~/.pi-comms/daemon.sock` (or `\\.\pipe\pi-comms` on Windows).
 *   - §"v4.2 Phase 4.4 Studio readiness as model-loaded check" (line 1155):
 *     replace `:8888`-port-open check with `GET /api/inference/status`;
 *     require `loaded[]` to contain the configured model id; wait up to 5
 *     min for the model to finish loading and surface a "studio up, model
 *     not loaded" diagnostic when it doesn't.
 *   - §"v4 changelog from Round-1 elder findings" PE Skeptic 0.0.0.0 row
 *     (line 1304): assert loopback Studio URL at boot; refuse non-loopback.
 *   - §"v4 changelog" PE Skeptic R2 #2 (paraphrased in the IMPL-16 brief):
 *     the dead-man heartbeat must reflect liveness of BOTH the channel
 *     long-poll AND the pi-mono Studio ping. v1 ships a stub setInterval
 *     touching the heartbeat file unconditionally — IMPL-19 replaces it.
 *
 * Architectural boundaries:
 *   - The daemon OWNS process lifecycle, ~/.pi-comms dir-tree creation, the
 *     IPC token bootstrap, the install-salt, the audit log writer, the
 *     boot-time Studio probe, the boot-time pointer-history archive, the
 *     telegram channel lifecycle, the slash-command router wiring, and the
 *     SIGTERM/SIGINT/SIGHUP shutdown handlers. SessionManager (IMPL-15)
 *     owns the SDK + AgentSession; the daemon hands sinks + deps to it.
 *   - The daemon DOES NOT OWN: SDK lifecycle, prompt composition, sandbox
 *     policy state-machine, classifier rules, status-pointer atomic writes
 *     (the writer module owns those), nor the IPC protocol shape. Those are
 *     all encapsulated by their respective W1+W2+W3 modules.
 */

import { mkdir, chmod, writeFile, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import "dotenv/config";

import { type AppConfig, ConfigurationError, loadConfig } from "./config.js";
import { AuditLog } from "./audit/log.js";
import {
  type OperatorLogger,
  createOperatorLogger,
} from "./utils/operator-logger.js";
import {
  loadAndValidateModelsJson,
  ModelsJsonValidationError,
  type ModelsJson,
} from "./lib/sdk-models-validator.js";
import { JsonStore } from "./storage/json-store.js";
import {
  TaskStateManager,
  type TaskState,
} from "./lib/task-state.js";
import { PendingConfirmsRegistry } from "./tools/pending-confirms.js";
import { SandboxPolicy, type SandboxState } from "./sandbox/policy.js";
import { StatusPointerReader } from "./status-pointer/reader.js";
import { StatusPointerWriter } from "./status-pointer/writer.js";
import {
  IpcServer,
  type AttachedClient,
  type IpcServerHandlers,
} from "./ipc/server.js";
import { ensureTokenFile } from "./ipc/protocol.js";
import { TelegramChannel, TelegramAuthError } from "./channels/telegram.js";
import {
  WhatsappChannel,
  BaileysNotInstalledError,
} from "./channels/whatsapp.js";
import { Heartbeat, type HeartbeatSource } from "./lib/heartbeat.js";
import {
  acquireLock,
  SingleInstanceLockError,
  type SingleInstanceLockHandle,
} from "./lib/single-instance-lock.js";
import {
  SessionAckTracker,
  type SessionAckPersistedState,
} from "./lib/session-ack-tracker.js";
import type {
  ChannelEvent,
  ChannelId,
  InboundMessage as ChannelInboundMessage,
  InboundProcessor,
  Sink,
} from "./channels/base.js";
import {
  SlashCommandRouter,
  type SlashCommandContext,
} from "./commands/slash.js";
import {
  SessionManager,
  type InboundMessage as SessionInboundMessage,
} from "./session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Test-mode marker: when PI_COMMS_DEFAULT_MODEL starts with this, the daemon
 *  skips Studio probe + skips SDK boot + skips Telegram (lets the integration
 *  smoke test boot the daemon hermetically without external services). */
const TEST_SKIP_STUDIO_PREFIX = "__test_skip_studio__";

/** How often the periodic drivers fire (ms): pendingConfirms.expire and
 *  sandboxPolicy.tickExpiration both ride the same interval to keep wake-ups
 *  cheap.  60s is generous: confirm TTLs are 30 minutes by default and
 *  sandbox windows are 1-120 minutes; sub-minute precision is unnecessary. */
const PERIODIC_TICK_INTERVAL_MS = 60_000;

/** How often heartbeat snapshots are read for state-transition emission.
 *  Per plan §"Heartbeat liveness from message-loop", touchAlive() fires
 *  on every successful channel poll / pi-ping; this interval just runs
 *  `getState()` so a stale source still emits `pi_stuck_suspected`
 *  even if no fresh polls arrive.  30s is a good balance. */
const HEARTBEAT_OBSERVE_INTERVAL_MS = 30_000;

/** Wait up to 5 minutes for the model to load before giving up at boot. */
const STUDIO_MODEL_WAIT_MS = 5 * 60 * 1000;

/** Re-poll interval while waiting for the model to load. */
const STUDIO_MODEL_POLL_MS = 5_000;

/** How often the audit-log retention sweep runs (FIX-B-2 #1).  Once per 24h
 *  is plenty: the underlying purgeOlderThan(N) deletes entire daily files,
 *  so finer-grained scheduling buys nothing.  Runs immediately at boot too
 *  to catch the case where the daemon was stopped for >24h. */
const AUDIT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public — error surface
// ---------------------------------------------------------------------------

/** Thrown by the boot sequence on misconfiguration that the daemon refuses
 *  to start with (non-loopback Studio URL, schema-drift in models.json, etc.). */
export class DaemonBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonBootError";
  }
}

// ---------------------------------------------------------------------------
// Public — DaemonOpts (tests use these to inject)
// ---------------------------------------------------------------------------

export interface DaemonOpts {
  /** When provided, overrides process.env.* loading. */
  config?: AppConfig;
  /** Override the IPC socket path (defaults to platform-appropriate location). */
  socketPath?: string;
  /**
   * Override fetch for the Studio readiness probe (tests inject a stub).
   * Defaults to the global `fetch` (Node ≥18).
   */
  fetchFn?: typeof fetch;
  /**
   * When true, don't actually invoke `process.exit` on shutdown — useful for
   * tests that want to assert clean teardown without crashing the runner.
   */
  exitOnShutdown?: boolean;
  /** Inject a logger (for tests). */
  operatorLogger?: OperatorLogger;
}

/** Returned by `start()` so callers (tests and the CLI entry) can drive the
 *  daemon programmatically. */
export interface RunningDaemon {
  /** Initiate graceful shutdown. Returns once everything is closed. */
  shutdown(reason: string): Promise<void>;
  /** Path the IPC server is bound on. */
  socketPath: string;
  /** Path to the IPC auth token. */
  tokenPath: string;
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

/**
 * Boot the daemon. Returns a `RunningDaemon` handle the caller can use to
 * orchestrate shutdown. Throws `DaemonBootError` / `ConfigurationError` /
 * `ModelsJsonValidationError` on misconfiguration.
 */
export async function start(opts: DaemonOpts = {}): Promise<RunningDaemon> {
  // 1. Load config (lifts env via dotenv side-effect on import).
  const config = opts.config ?? loadConfig();

  // 1b. AUDIT-D #4: Windows-without-explicit-opt-in gate.  The Windows
  //     sandbox (Job Objects) is not implemented in v1; running unsandboxed
  //     on Windows is a security regression that must be acknowledged
  //     explicitly.  Test mode bypasses this gate so the integration
  //     smoke can run on any host.
  const testMode = config.piCommsDefaultModel.startsWith(TEST_SKIP_STUDIO_PREFIX);
  if (
    !testMode &&
    platform() === "win32" &&
    process.env.PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS !== "true"
  ) {
    throw new DaemonBootError(
      "pi-comms refuses to start on Windows without explicit opt-in. " +
        "v1 lacks a Windows-native sandbox (Job Objects); the bash tool " +
        "would run unsandboxed.  Set PI_COMMS_ALLOW_UNSANDBOXED_WINDOWS=true " +
        "to acknowledge this risk.  See docs/INSTALL.md for details."
    );
  }

  // 2. Materialize ~/.pi-comms tree (mode 0700) so audit/store/socket calls
  //    don't race the parent dir into existence.
  const home = config.piCommsHome;
  await ensureSecureDir(home);
  await ensureSecureDir(config.piCommsWorkspace);

  // 2b. Pitfall #11: single-instance lock.  Refuse to start if another
  //     daemon already holds the lock.  Stale lockfiles (PID dead) are
  //     reaped automatically.  Acquired BEFORE IPC server bind so two
  //     daemons cannot race to bind the same socket.  Released by the
  //     daemon's shutdown handler; if boot itself throws, the catch
  //     below releases.
  const lockPath = join(home, "daemon.pid");
  let singleInstanceLock: SingleInstanceLockHandle;
  try {
    singleInstanceLock = await acquireLock(lockPath);
  } catch (err) {
    if (err instanceof SingleInstanceLockError) {
      throw new DaemonBootError(
        `another pi-comms daemon (pid=${err.pid}) is already running. ` +
          `Refusing to start to avoid conflict on ${home}.`,
      );
    }
    throw err;
  }

  let bootSucceeded = false;
  try {
    const handle = await bootAfterLock({
      opts,
      config,
      home,
      testMode,
      singleInstanceLock,
    });
    bootSucceeded = true;
    return handle;
  } finally {
    if (!bootSucceeded) {
      await singleInstanceLock.release().catch(() => undefined);
    }
  }
}

interface BootAfterLockArgs {
  opts: DaemonOpts;
  config: AppConfig;
  home: string;
  testMode: boolean;
  singleInstanceLock: SingleInstanceLockHandle;
}

/** Continuation of `start()` that runs AFTER the single-instance lock
 *  has been acquired.  Split out so the lock can be released in a
 *  single try/finally up in `start()` whenever boot fails. */
async function bootAfterLock(
  args: BootAfterLockArgs,
): Promise<RunningDaemon> {
  const { opts, config, home, testMode, singleInstanceLock } = args;

  // 3. IPC auth token bootstrap. Re-using ensureTokenFile guarantees the
  //    parent dir is mode 0700 and the token file is mode 0600.
  const tokenPath = join(home, "ipc-token");
  const authToken = await ensureTokenFile(tokenPath);

  // 4. Install salt — required by AuditLog.senderIdHash. Cheap to derive once
  //    and persist; survives daemon restarts so audit hashes are stable.
  //    Per FIX-B-2 #4: capture any parse-failure metadata so we can emit
  //    a forensic `audit_log_corruption_detected` row AFTER the AuditLog
  //    is constructed (we can't emit it here yet — auditLog doesn't exist).
  const saltResult = await ensureInstallSalt(home);
  const installSalt = saltResult.salt;

  // 5. Audit log + operator logger.
  const daemonStartTs = Date.now();
  const auditLog = new AuditLog({
    dir: join(home, "audit"),
    daemonStartTs,
    retentionDays: config.piCommsAuditRetentionDays,
  });

  // 5b. FIX-B-2 #4: if install.json was corrupt, emit the forensic row
  //     BEFORE anything else uses the audit log so post-incident review can
  //     locate the regen event chronologically.  Best-effort; never block
  //     boot on a logging failure.
  if (saltResult.corruption) {
    void auditLog
      .append({
        event: "audit_log_corruption_detected",
        task_id: null,
        channel: "system",
        sender_id_hash: null,
        error_class: saltResult.corruption.errorClass,
        extra: {
          file: "install.json",
          message: saltResult.corruption.message.slice(0, 200),
        },
      })
      .catch(() => undefined);
  }

  const operatorLogger =
    opts.operatorLogger ??
    createOperatorLogger({
      level: config.operatorLogLevel,
      style: config.operatorLogStyle,
      includeContent: config.operatorLogContent,
      previewChars: config.operatorLogPreviewChars,
      // AUDIT-A #18: tee operator-log lines to ~/.pi-comms/operator.log
      // with daily rotation so post-incident review has more than the
      // 60-second console scrollback to work with.  Tests opt-out by
      // injecting their own logger via opts.operatorLogger.
      filePath: join(home, "operator.log"),
    });

  // (testMode evaluated at boot-gate; see step 1b.)

  operatorLogger.banner({
    bot: config.telegramBotToken ? "telegram" : "(disabled)",
    mode: testMode ? "test" : "production",
    workers: "0/1",
    model: config.piCommsDefaultModel,
    sessions: "shared",
  });
  // Audit a daemon_boot at the orchestrator level (the IPC server emits its
  // own daemon_boot for socket bind; this row captures the env-load step
  // independently so post-incident review can correlate the two).
  void auditLog
    .append({
      event: "daemon_boot",
      task_id: null,
      channel: "system",
      sender_id_hash: null,
      extra: {
        ipc_event: "orchestrator_start",
        test_mode: testMode,
      },
    })
    .catch(() => undefined);

  // 6. Studio readiness — both the loopback assertion and Phase 4.4 model-
  //    loaded check. Skipped in test mode so the integration smoke can boot
  //    without a real Studio.  We also capture studioUrl + modelId for the
  //    cold-start probe wired into SessionManager (Pitfall #20 / FIX-B-1 #4).
  let coldStartStudioUrl: string | null = null;
  let coldStartModelId: string | null = null;
  const fetchFn = opts.fetchFn ?? fetch;
  if (!testMode) {
    const modelsJson = await loadModelsJsonOrFail(config, operatorLogger);
    const studioUrl = extractStudioBaseUrl(modelsJson, config.piCommsDefaultModel);
    assertLoopbackUrl(studioUrl);
    coldStartStudioUrl = studioUrl;
    coldStartModelId = await waitForStudioModelLoaded({
      baseUrl: studioUrl,
      modelId: extractModelId(config.piCommsDefaultModel),
      apiKey: config.unslothApiKey,
      fetchFn,
      logger: operatorLogger,
    });
    operatorLogger.info("studio_swap_detection_armed", {
      baseline_model: coldStartModelId,
    });
  }

  // 7. Sandbox policy: load persisted state then unconditionally force-engage
  //    on boot (per plan §"v4.2 Sandbox state on daemon boot" line 1483).
  const sandboxStore = new JsonStore<SandboxState>(
    join(home, "sandbox-state.json")
  );
  const sandboxPolicy = new SandboxPolicy({ jsonStore: sandboxStore, auditLog });
  await sandboxPolicy.forceEngagedOnBoot(daemonStartTs);

  // 8. Task state manager — restore from disk inside SessionManager.init();
  //    we just construct the manager here.
  const taskState = new TaskStateManager({
    persistencePath: join(home, "task-state.json"),
  });

  // 8b. SessionAckTracker — RS-6 session-boundary detection for /unsand.
  //     Plan v4.2 §"Session boundary precisely defined".  Replaces the v1
  //     hardcoded `isFirstUnsandPerSession: () => true` and
  //     `getUnsandRequiresTerminalAck: () => false` we had before.
  const sessionAckStore = new JsonStore<SessionAckPersistedState>(
    join(home, "session-ack-tracker.json"),
  );
  const sessionAckTracker = new SessionAckTracker({
    jsonStore: sessionAckStore,
    daemonStartTs,
  });
  await sessionAckTracker.load();

  // 9. Pending confirms registry (in-memory).
  const pendingConfirms = new PendingConfirmsRegistry();

  // 10. Status pointer reader + writer. Archive prior body BEFORE the boot
  //     header update destroys it (per Observability §"pointer-history.jsonl").
  const pointerPath = join(home, "status-pointer.md");
  const pointerReader = new StatusPointerReader({ path: pointerPath });
  const pointerWriter = new StatusPointerWriter({ path: pointerPath });
  await pointerWriter.archivePriorOnBoot();
  await pointerWriter.updateHeader({
    daemonStarted: new Date(daemonStartTs).toISOString(),
    lastUpdated: new Date(daemonStartTs).toISOString(),
  });

  // 11. IPC server. We pass placeholder handlers now and rebind them once the
  //     SessionManager + slash router are ready — the IPC server doesn't accept
  //     connections until `start()` is awaited below, so the swap is safe.
  const socketPath = opts.socketPath ?? defaultSocketPath(home);
  const handlerHolder: { current: IpcServerHandlers } = {
    current: makeBootstrapHandlers(),
  };
  const ipcServer = new IpcServer({
    socketPath,
    authToken,
    handlers: makeForwardingHandlers(handlerHolder),
    auditLog,
    operatorLogger,
  });

  // 12. Heartbeat: required sources derived from configured channels.
  //     `pi-ping` is always required; `telegram-poll` if telegramBotToken
  //     set; `baileys-poll` if config.whatsapp set.  In test mode we still
  //     construct the heartbeat (it's needed by `/alive`) but only require
  //     pi-ping (which the SDK isn't actually started, so we touch it
  //     manually below to keep the gauge healthy for tests).
  const heartbeatPath = join(home, "daemon.heartbeat");
  const requiredHeartbeatSources: HeartbeatSource[] = ["pi-ping"];
  if (!testMode && config.telegramBotToken) {
    requiredHeartbeatSources.push("telegram-poll");
  }
  if (!testMode && config.whatsapp) {
    requiredHeartbeatSources.push("baileys-poll");
  }
  const heartbeat = new Heartbeat({
    heartbeatPath,
    healthyMaxAgeMs: 90_000,
    degradedMaxAgeMs: 180_000,
    requiredSources: requiredHeartbeatSources,
    auditLog,
    operatorLogger,
  });

  // lockState materialized early so SessionManager observers can plumb
  // lastTellAt updates through the same shared object.
  const lockState = { locked: false, lastTellAt: null as number | null };

  // 13. SessionManager: shared AgentSession + custom tools. The sinks include
  //     the IPC server (terminal-style fan-out) plus telegram (set up below);
  //     the manager holds a reference to `sinks` and re-fan-outs as events
  //     arrive. We pre-create the bag here and mutate it after telegram /
  //     whatsapp init succeeds — Sink fan-out tolerates a missing key.
  const sessionSinks: { terminal: Sink; whatsapp?: Sink; telegram?: Sink } = {
    terminal: ipcServer,
  };

  const sessionManager = new SessionManager({
    config,
    taskState,
    pendingConfirms,
    sandboxPolicy,
    auditLog,
    operatorLogger,
    sinks: sessionSinks,
    onPiActivity: () => {
      // pi-ping heartbeat.  Best-effort — never let a touchAlive failure
      // crash the agent stream.
      void heartbeat.touchAlive({ source: "pi-ping" }).catch(() => undefined);
    },
    onTellEmit: (ts) => {
      lockState.lastTellAt = ts;
    },
    // Pitfall #20 / FIX-B-1 #4: cold-start suppression.  When the
    // first auto-promote is about to fire, probe Studio for model-
    // loaded.  If not loaded, emit "warming up" and reschedule.  In
    // test mode we have no studio URL — omit the probe entirely so
    // the auto-promote fires per v3 behavior.
    isStudioModelLoaded:
      coldStartStudioUrl && coldStartModelId
        ? () =>
            probeStudioModelLoaded({
              baseUrl: coldStartStudioUrl as string,
              modelId: coldStartModelId as string,
              apiKey: config.unslothApiKey,
              fetchFn,
            })
        : undefined,
    ...(coldStartStudioUrl && coldStartModelId
      ? {
          coldStartModelId,
          getStudioLoadedModelIds: () =>
            getStudioLoadedModelIds({
              baseUrl: coldStartStudioUrl as string,
              apiKey: config.unslothApiKey,
              fetchFn,
            }),
        }
      : {}),
  });

  if (!testMode) {
    await sessionManager.init();
  } else {
    operatorLogger.info("daemon_boot", {
      test_mode: true,
      reason: "PI_COMMS_DEFAULT_MODEL starts with __test_skip_studio__; skipping SDK init",
    });
    // In test mode, prime the pi-ping source so /status doesn't pin at
    // 'dead' for the integration smoke.  This mirrors what the first SDK
    // event would do in production.
    void heartbeat.touchAlive({ source: "pi-ping" }).catch(() => undefined);
  }

  // 14. Telegram + WhatsApp channels.  Bare-config daemons run terminal-only.
  let telegramChannel: TelegramChannel | null = null;
  let whatsappChannel: WhatsappChannel | null = null;
  const inboundProcessor: InboundProcessor = {
    async processInbound(msg: ChannelInboundMessage): Promise<void> {
      await handleChannelInbound(msg, {
        slashRouter: () => slashRouter,
        sessionManager,
        sinks: sessionSinks,
        ipcServer,
        operatorLogger,
        telegramChannel: () => telegramChannel,
        installSalt,
        lockState,
        auditLog,
      });
    },
  };

  if (!testMode && config.telegramBotToken) {
    try {
      telegramChannel = new TelegramChannel({
        botToken: config.telegramBotToken,
        allowedUserIds: config.telegramAllowedUserIds,
        inboundProcessor,
        auditLog,
        operatorLogger,
        onPoll: () => {
          void heartbeat
            .touchAlive({ source: "telegram-poll" })
            .catch(() => undefined);
        },
      });
      await telegramChannel.start();
      sessionSinks.telegram = telegramChannel;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      operatorLogger.error("telegram_disconnect", {
        reason: "boot_start_failed",
        error: message,
      });
      telegramChannel = null;
      if (err instanceof TelegramAuthError) {
        // Surface a clear diagnostic but do NOT halt boot — the daemon is
        // still useful via terminal even without telegram.
        operatorLogger.error("telegram_disconnect", {
          reason: "auth_failure_continuing_terminal_only",
        });
      }
      void auditLog
        .append({
          event: "telegram_disconnect",
          task_id: null,
          channel: "telegram",
          sender_id_hash: null,
          extra: { reason: "boot_start_failed", error: message.slice(0, 200) },
        })
        .catch(() => undefined);
    }
  } else if (!config.telegramBotToken) {
    operatorLogger.info("telegram_disconnect", {
      reason: "no_bot_token_configured",
    });
  }

  if (!testMode && config.whatsapp) {
    try {
      const wa = config.whatsapp;
      whatsappChannel = new WhatsappChannel({
        identityModel: wa.identityModel,
        ownerJid: wa.ownerJid,
        botJid: wa.botJid,
        authStateDir: join(home, "wa-auth"),
        inboundProcessor,
        auditLog,
        operatorLogger,
        onPoll: () => {
          void heartbeat
            .touchAlive({ source: "baileys-poll" })
            .catch(() => undefined);
        },
      });
      await whatsappChannel.start();
      sessionSinks.whatsapp = whatsappChannel;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      operatorLogger.error("whatsapp_disconnect", {
        reason: "boot_start_failed",
        error: message,
      });
      void auditLog
        .append({
          event: "whatsapp_disconnect",
          task_id: null,
          channel: "whatsapp",
          sender_id_hash: null,
          extra: { reason: "boot_start_failed", error: message.slice(0, 200) },
        })
        .catch(() => undefined);
      if (err instanceof BaileysNotInstalledError) {
        operatorLogger.error("whatsapp_disconnect", {
          reason: "baileys_not_installed_continuing_without_whatsapp",
        });
      }
      whatsappChannel = null;
    }
  }

  // 15. Slash-command router. Wires deps for /unsand, /lock, /alive, etc.
  let shutdownInFlight: Promise<void> | null = null;
  const slashRouter = new SlashCommandRouter({
    taskState,
    pendingConfirms,
    sandboxPolicy,
    statusPointerReader: pointerReader,
    auditLog,
    operatorLogger,
    onPanicLock: async () => {
      lockState.locked = true;
      operatorLogger.info("classifier_block", { reason: "panic_lock_engaged" });
    },
    onPanicUnlock: async () => {
      lockState.locked = false;
      operatorLogger.info("unsand_disabled", { reason: "panic_unlock" });
      // RS-6 rule (c): record the /lock+/unlock cycle so the next
      // /unsand requires terminal-side ack (per plan v4.2 §"Session
      // boundary precisely defined").  The tracker persists this
      // through restart; recordTerminalAck() clears it.
      sessionAckTracker.recordLockCycle();
    },
    onAlive: () => {
      // RS-1 dead-man heartbeat bump. Touch the file mtime so the dead-man
      // switch (Phase 4.0 / IMPL-19) sees the user is alive.  Using
      // touchAlive on the pi-ping source is a pragmatic shortcut — the
      // user told us they're alive, which logically implies the comms
      // path between user and daemon is fine.
      void heartbeat.touchAlive({ source: "pi-ping" }).catch(() => undefined);
    },
    onCancelTask: async () => {
      const cur = taskState.get();
      if (cur.kind !== "running" && cur.kind !== "backgrounded") {
        return { cancelled: false };
      }
      try {
        cur.abort.abort();
      } catch {
        /* abort signals are best-effort */
      }
      const cancelledAt = Date.now();
      taskState.tryTransition({
        kind: "cancelled",
        taskId: cur.taskId,
        startedAt: cur.startedAt,
        cancelledAt,
        reason: "user",
      });
      // Audit task_cancelled with duration_ms so post-incident review can
      // correlate cancel latency with downstream events.
      void auditLog
        .append({
          event: "task_cancelled",
          task_id: cur.taskId,
          channel: cur.channel,
          sender_id_hash: null,
          duration_ms: Math.max(0, cancelledAt - cur.startedAt),
          extra: { reason: "user" },
        })
        .catch(() => undefined);
      return { cancelled: true, taskId: cur.taskId };
    },
    onResetSession: async () => {
      // v1 reset = re-engage sandbox + clear pending confirms. SDK
      // re-init is left for v2; the agent's context resets implicitly when
      // the next prompt arrives.
      pendingConfirms.clear();
      sandboxPolicy.enable();
    },
    onShutdownDaemon: async () => {
      // Spawn shutdown but don't await here — the slash router is
      // synchronous from the channel handler's POV and we need to send
      // the "/shutdown" reply before the socket closes.
      if (!shutdownInFlight) {
        shutdownInFlight = handle.shutdown("slash_command");
      }
    },
    getLastTellAt: () => lockState.lastTellAt,
    // RS-6: replace the v1-hardcoded callbacks with SessionAckTracker
    // queries (FIX-B-1 #2).  `isFirstUnsandPerSession` returns true
    // whenever ANY of rules (a)-(e) fires — which is the conservative
    // gate the plan v4.2 §"Session boundary precisely defined" calls
    // for.  `getUnsandRequiresTerminalAck` stays `false` because the
    // tool-derived flag is folded into requiresTerminalAck() via the
    // taskId-context'd rule (e) check; the slash router OR-combines
    // both callbacks so this avoids double-gating.
    isFirstUnsandPerSession: () =>
      sessionAckTracker.requiresTerminalAck({
        taskId: getCurrentTaskIdFromState(taskState),
      }),
    getUnsandRequiresTerminalAck: () => false,
  });

  // 15. Wire the IPC handlers now that everything is constructed.
  handlerHolder.current = makeProductionHandlers({
    auditLog,
    operatorLogger,
    sessionManager,
    slashRouter,
    pointerWriter,
    sinks: sessionSinks,
    ipcServer,
    taskState,
    sandboxPolicy,
    onShutdown: () => {
      if (!shutdownInFlight) {
        shutdownInFlight = handle.shutdown("ipc_shutdown");
      }
      return shutdownInFlight;
    },
    lockState,
  });

  // 17. Bind the socket. After this, attached clients can connect.
  await ipcServer.start();

  // 18. Periodic drivers.  Three independent timers:
  //
  //     a) Heartbeat observation — runs `getState()` so a stale source
  //        still emits `pi_stuck_suspected` even when no fresh polls
  //        arrive.  touchAlive() handles the touched-file write itself.
  //     b) Periodic tick — calls `pendingConfirms.expire(now)` (AUDIT-C
  //        #6) and `sandboxPolicy.tickExpiration(now)` (AUDIT-B #14).
  //        Both are cheap when nothing is open; combined to share the
  //        same wake-up.
  const heartbeatObserveTimer = setInterval(() => {
    void heartbeat.getState().catch(() => undefined);
  }, HEARTBEAT_OBSERVE_INTERVAL_MS);
  heartbeatObserveTimer.unref?.();

  const periodicTickTimer = setInterval(() => {
    const now = Date.now();
    // AUDIT-C #6: expire pending confirms; emit confirm_timed_out per entry.
    try {
      const expired = pendingConfirms.expire(now);
      for (const e of expired) {
        void auditLog
          .append({
            event: "confirm_timed_out",
            task_id: e.taskId,
            channel: e.channel,
            sender_id_hash: null,
            extra: { short_id: e.shortId },
          })
          .catch(() => undefined);
      }
    } catch (err) {
      operatorLogger.error("chat_error", {
        context: "pending_confirms_expire",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // AUDIT-B #14: re-engage sandbox if a window-scoped grant has expired.
    // The policy itself emits the `unsand_disabled` audit row; we just
    // surface a `system_notice` to the originating channel so Sergio
    // sees "sandbox re-engaged" without needing to refresh /status.
    try {
      const result = sandboxPolicy.tickExpiration(now);
      if (result.stateChanged && result.newState.kind === "engaged") {
        // We don't track the originating channel on the policy itself —
        // broadcast to all configured sinks.  The channel layer will
        // silently drop on transports that have no active session.
        const event: ChannelEvent = {
          type: "system_notice",
          text: "pi: sandbox re-engaged (window expired).",
          level: "info",
          ts: now,
        };
        const broadcast = async () => {
          for (const sink of [
            sessionSinks.terminal,
            sessionSinks.telegram,
            sessionSinks.whatsapp,
          ]) {
            if (sink) {
              await sink.send(event).catch(() => undefined);
            }
          }
        };
        void broadcast();
      }
    } catch (err) {
      operatorLogger.error("chat_error", {
        context: "sandbox_tick_expiration",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, PERIODIC_TICK_INTERVAL_MS);
  periodicTickTimer.unref?.();

  // 18c. FIX-B-2 #1: scheduled audit-log retention sweep.  Calls
  //      `auditLog.purgeOlderThan(config.piCommsAuditRetentionDays)` once
  //      shortly after boot and then every 24h.  Each sweep logs the count
  //      via the operator logger so a tail-the-log-and-grep operator can
  //      see retention working.
  const runAuditPurge = async (): Promise<void> => {
    try {
      const count = await auditLog.purgeOlderThan(
        config.piCommsAuditRetentionDays,
      );
      operatorLogger.info("daemon_boot", {
        sweep: "audit_log_purge",
        retention_days: config.piCommsAuditRetentionDays,
        purged: count,
      });
    } catch (err) {
      operatorLogger.error("chat_error", {
        context: "audit_log_purge",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // First sweep: 60s after boot so we don't burn CPU during the noisy
  // startup window.  Subsequent sweeps: every 24h.
  const auditPurgeKickoffTimer = setTimeout(() => {
    void runAuditPurge();
  }, 60_000);
  auditPurgeKickoffTimer.unref?.();
  const auditPurgeTimer = setInterval(() => {
    void runAuditPurge();
  }, AUDIT_PURGE_INTERVAL_MS);
  auditPurgeTimer.unref?.();

  // 18. Signal handlers.
  const handle: RunningDaemon = {
    socketPath,
    tokenPath,
    async shutdown(reason: string): Promise<void> {
      if (shutdownInFlight) {
        await shutdownInFlight;
        return;
      }
      shutdownInFlight = (async () => {
        operatorLogger.info("daemon_shutdown", { reason });
        clearInterval(heartbeatObserveTimer);
        clearInterval(periodicTickTimer);
        clearTimeout(auditPurgeKickoffTimer);
        clearInterval(auditPurgeTimer);

        // Cancel any in-flight task gracefully.  FIX-B-1 #5: emit a
        // `task_cancelled` audit row with `reason: 'shutdown'` so signal-
        // induced shutdowns (SIGTERM/SIGINT/SIGHUP) leave a forensic
        // trail.  Without this, post-incident review sees a daemon
        // shutdown with no record of what happened to the in-flight
        // task — a real gap noted by the BLESS round.
        const cur = taskState.get();
        if (cur.kind === "running" || cur.kind === "backgrounded") {
          try {
            cur.abort.abort();
          } catch {
            /* best-effort */
          }
          const cancelledAt = Date.now();
          taskState.tryTransition({
            kind: "cancelled",
            taskId: cur.taskId,
            startedAt: cur.startedAt,
            cancelledAt,
            reason: "shutdown",
          });
          void auditLog
            .append({
              event: "task_cancelled",
              task_id: cur.taskId,
              channel: cur.channel,
              sender_id_hash: null,
              duration_ms: Math.max(0, cancelledAt - cur.startedAt),
              extra: { reason: "shutdown" },
            })
            .catch(() => undefined);
        }
        await taskState.flush();
        // Persist any pending session-ack-tracker writes so the next
        // boot's RS-6 rules see consistent state.
        await sessionAckTracker.flush().catch(() => undefined);

        // Close everything. Each tear-down is best-effort; we capture the
        // first error for the audit row but never re-throw.
        const errors: string[] = [];
        if (telegramChannel) {
          try {
            await telegramChannel.stop();
          } catch (err) {
            errors.push(
              `telegram_stop:${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        if (whatsappChannel) {
          try {
            await whatsappChannel.stop();
          } catch (err) {
            errors.push(
              `whatsapp_stop:${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        try {
          await sessionManager.dispose();
        } catch (err) {
          errors.push(
            `session_dispose:${err instanceof Error ? err.message : String(err)}`
          );
        }
        try {
          await ipcServer.stop();
        } catch (err) {
          errors.push(
            `ipc_stop:${err instanceof Error ? err.message : String(err)}`
          );
        }
        pendingConfirms.clear();

        await auditLog
          .append({
            event: "daemon_shutdown",
            task_id: null,
            channel: "system",
            sender_id_hash: null,
            extra: {
              reason,
              errors: errors.length > 0 ? errors.join("; ") : "none",
            },
          })
          .catch(() => undefined);

        // Release the single-instance lock so the next daemon boot can
        // succeed without needing to reap a stale lockfile (Pitfall #11).
        await singleInstanceLock.release().catch(() => undefined);
      })();
      await shutdownInFlight;
    },
  };

  installSignalHandlers(handle, operatorLogger, opts.exitOnShutdown ?? false);

  return handle;
}

// ---------------------------------------------------------------------------
// Inbound routing — slash-command-first, then SessionManager.
// ---------------------------------------------------------------------------

interface InboundContext {
  slashRouter: () => SlashCommandRouter;
  sessionManager: SessionManager;
  sinks: { terminal: Sink; whatsapp?: Sink; telegram?: Sink };
  ipcServer: IpcServer;
  telegramChannel: () => TelegramChannel | null;
  operatorLogger: OperatorLogger;
  installSalt: string;
  lockState: { locked: boolean; lastTellAt: number | null };
  auditLog: AuditLog;
}

/**
 * Route one inbound channel message:
 *   1. Tee through the slash router. If `handled=true`, send the reply to
 *      the originating sink and stop.
 *   2. Otherwise, hand to `SessionManager.handleInbound`.
 */
async function handleChannelInbound(
  msg: ChannelInboundMessage,
  ctx: InboundContext
): Promise<void> {
  const text = msg.payload.text ?? "";
  const senderHash = AuditLog.senderIdHash(msg.sender.id, ctx.installSalt);

  // AUDIT-D #3: lockState gate.  When `/lock` has been engaged, refuse
  // every non-`/unlock` slash command AND every non-slash inbound.  The
  // dispatcher itself enforces "unlock is terminal-only" so a phone-side
  // `/unlock` will never bypass this gate even if the gate weren't here.
  if (ctx.lockState.locked) {
    const trimmed = text.trimStart().toLowerCase();
    const isUnlock =
      trimmed.startsWith("/unlock") &&
      (trimmed.length === "/unlock".length ||
        /[\s@]/.test(trimmed[7] ?? ""));
    if (!isUnlock) {
      // Surface a system_notice to the originating channel so the user
      // understands why their input was dropped.
      const sink = sinkFor(msg.channel, ctx.sinks);
      if (sink) {
        const event: ChannelEvent = {
          type: "system_notice",
          text: "pi: locked. /unlock from terminal to resume.",
          level: "warn",
          ts: Date.now(),
        };
        await sink.send(event).catch(() => undefined);
      }
      void ctx.auditLog
        .append({
          event: "lock_engaged_reject",
          task_id: null,
          channel: msg.channel,
          sender_id_hash: senderHash,
          extra: {
            input_starts_with_slash: text.trimStart().startsWith("/"),
          },
        })
        .catch(() => undefined);
      return;
    }
  }

  // Slash routing: only line-leading `/`. The router itself checks the same;
  // we delegate the parse and act on the result.
  const slashCtx: SlashCommandContext = {
    raw: text,
    senderChannel: msg.channel,
    senderId: senderHash,
    isTerminal: msg.channel === "terminal",
  };
  const slashResult = await ctx.slashRouter().dispatch(slashCtx);
  if (slashResult.handled) {
    if (slashResult.reply) {
      const sink = sinkFor(msg.channel, ctx.sinks);
      if (sink) {
        const event: ChannelEvent = {
          type: "reply",
          text: slashResult.reply,
          ts: Date.now(),
        };
        await sink.send(event).catch(() => undefined);
      }
    }
    return;
  }

  // Non-slash inbound goes to the SessionManager.
  const inbound: SessionInboundMessage = {
    channel: msg.channel,
    text,
    senderId: senderHash,
  };
  await ctx.sessionManager.handleInbound(inbound).catch((err) => {
    ctx.operatorLogger.error("chat_error", {
      channel: msg.channel,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function sinkFor(
  channel: ChannelId,
  sinks: { terminal: Sink; whatsapp?: Sink; telegram?: Sink }
): Sink | undefined {
  if (channel === "terminal") return sinks.terminal;
  if (channel === "telegram") return sinks.telegram;
  if (channel === "whatsapp") return sinks.whatsapp;
  return undefined;
}

// ---------------------------------------------------------------------------
// IPC handler factories
// ---------------------------------------------------------------------------

/** Pre-construction handlers — every verb returns "not ready" until the real
 *  set is swapped in. The IPC server is bound only AFTER the swap, so this
 *  set should never actually be invoked, but the handler interface requires
 *  *something* to be present at construction time. */
function makeBootstrapHandlers(): IpcServerHandlers {
  const reject = () => Promise.reject(new Error("daemon not ready"));
  return {
    onSend: () => reject(),
    onStatus: () => reject(),
    onHistory: () => reject(),
    onShutdown: () => reject(),
    onPointerWrite: () => reject(),
  };
}

/** Indirection so the IPC server's handler set can be swapped after
 *  construction (we need the slash router + session manager wired before
 *  we can build the real handlers). */
function makeForwardingHandlers(holder: {
  current: IpcServerHandlers;
}): IpcServerHandlers {
  return {
    onSend: (...args) => holder.current.onSend(...args),
    onStatus: () => holder.current.onStatus(),
    onHistory: (...args) => holder.current.onHistory(...args),
    onShutdown: () => holder.current.onShutdown(),
    onPointerWrite: (...args) => holder.current.onPointerWrite(...args),
  };
}

interface ProductionHandlersDeps {
  auditLog: AuditLog;
  operatorLogger: OperatorLogger;
  sessionManager: SessionManager;
  slashRouter: SlashCommandRouter;
  pointerWriter: StatusPointerWriter;
  sinks: { terminal: Sink; whatsapp?: Sink; telegram?: Sink };
  ipcServer: IpcServer;
  taskState: TaskStateManager;
  sandboxPolicy: SandboxPolicy;
  onShutdown: () => Promise<void>;
  lockState: { locked: boolean; lastTellAt: number | null };
}

function makeProductionHandlers(deps: ProductionHandlersDeps): IpcServerHandlers {
  return {
    async onSend(text: string, attached: AttachedClient): Promise<void> {
      // The IPC server already gates by attach-token; this is the real entry
      // for terminal-originated inbound. Tee through the slash router first.
      const senderHash = `ipc-${attached.id}`;

      // AUDIT-D #3: lockState gate (terminal entry path).  Same semantics
      // as handleChannelInbound: refuse every non-`/unlock` input.  The
      // terminal IS the only place /unlock works, so this is the surface
      // where the operator unsticks the daemon.
      if (deps.lockState.locked) {
        const trimmed = text.trimStart().toLowerCase();
        const isUnlock =
          trimmed.startsWith("/unlock") &&
          (trimmed.length === "/unlock".length ||
            /[\s@]/.test(trimmed[7] ?? ""));
        if (!isUnlock) {
          const event: ChannelEvent = {
            type: "system_notice",
            text: "pi: locked. /unlock from terminal to resume.",
            level: "warn",
            ts: Date.now(),
          };
          await deps.ipcServer.send(event).catch(() => undefined);
          void deps.auditLog
            .append({
              event: "lock_engaged_reject",
              task_id: null,
              channel: "terminal",
              sender_id_hash: senderHash,
              extra: {
                input_starts_with_slash: text.trimStart().startsWith("/"),
              },
            })
            .catch(() => undefined);
          return;
        }
      }

      const slashCtx: SlashCommandContext = {
        raw: text,
        senderChannel: "terminal",
        senderId: senderHash,
        isTerminal: true,
      };
      const result = await deps.slashRouter.dispatch(slashCtx);
      if (result.handled) {
        if (result.reply) {
          const event: ChannelEvent = {
            type: "reply",
            text: result.reply,
            ts: Date.now(),
          };
          // The IPC server fans events to ALL attached clients via the Sink
          // interface; we use it directly so the originating client + any
          // siblings see the slash-command reply consistently.
          await deps.ipcServer.send(event).catch(() => undefined);
        }
        return;
      }

      // Non-slash → SessionManager.
      const inbound: SessionInboundMessage = {
        channel: "terminal",
        text,
        senderId: senderHash,
      };
      await deps.sessionManager.handleInbound(inbound).catch((err) => {
        deps.operatorLogger.error("chat_error", {
          channel: "terminal",
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    async onStatus(): Promise<{ summary: string; taskState: TaskState }> {
      const ts = deps.taskState.get();
      const summary = formatStatusSummary(ts, deps.sandboxPolicy.isSandboxed());
      return { summary, taskState: ts };
    },
    async onHistory(limit: number): Promise<unknown[]> {
      // v1 history reads tail of today's audit JSONL. Returning a small,
      // bounded view; full history queries belong to a separate `pi-comms
      // export` subcommand left for v2.
      try {
        const path = deps.auditLog.currentLogPath();
        const raw = await readFile(path, "utf8");
        const lines = raw.split("\n").filter((l) => l.length > 0);
        const tail = lines.slice(Math.max(0, lines.length - limit));
        return tail.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
      } catch (err) {
        deps.operatorLogger.error("chat_error", {
          context: "history_read",
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },
    async onShutdown(): Promise<void> {
      void deps.onShutdown();
    },
    async onPointerWrite(body: string): Promise<{
      written: boolean;
      truncated: boolean;
    }> {
      const result = await deps.pointerWriter.writeBody(body);
      return result;
    },
  };
}

function formatStatusSummary(ts: TaskState, sandboxed: boolean): string {
  const sb = `sandbox=${sandboxed ? "on" : "off"}`;
  if (ts.kind === "idle") return `idle  ${sb}`;
  if (ts.kind === "running") {
    return `running id=${ts.taskId} channel=${ts.channel}  ${sb}`;
  }
  if (ts.kind === "backgrounded") {
    return `backgrounded id=${ts.taskId} channel=${ts.channel} promotedBy=${ts.promotedBy}  ${sb}`;
  }
  if (ts.kind === "completed") return `completed id=${ts.taskId}  ${sb}`;
  if (ts.kind === "cancelled") {
    return `cancelled id=${ts.taskId} reason=${ts.reason}  ${sb}`;
  }
  return `failed id=${ts.taskId}  ${sb}`;
}

// ---------------------------------------------------------------------------
// Studio readiness — Phase 4.4 model-loaded check + loopback assertion
// ---------------------------------------------------------------------------

async function loadModelsJsonOrFail(
  config: AppConfig,
  logger: OperatorLogger
): Promise<ModelsJson> {
  try {
    return await loadAndValidateModelsJson(config.piModelsJson);
  } catch (err) {
    if (err instanceof ModelsJsonValidationError) {
      logger.error("daemon_shutdown", {
        reason: "models_json_invalid",
        path: config.piModelsJson,
        issues: err.issues,
      });
    }
    throw err;
  }
}

/**
 * Extract the Studio base URL from models.json given a `provider/modelId`
 * spec. We split on the first `/` — provider ids from pi-mono are slash-free.
 * Throws DaemonBootError if the provider isn't found.
 */
export function extractStudioBaseUrl(
  models: ModelsJson,
  providerSlashModel: string
): string {
  const slash = providerSlashModel.indexOf("/");
  const providerId =
    slash > 0 ? providerSlashModel.slice(0, slash) : providerSlashModel;
  const provider = models.providers[providerId];
  if (!provider) {
    throw new DaemonBootError(
      `models.json does not declare provider '${providerId}' (PI_COMMS_DEFAULT_MODEL=${providerSlashModel})`
    );
  }
  if (!provider.baseUrl) {
    throw new DaemonBootError(
      `provider '${providerId}' has no baseUrl in models.json`
    );
  }
  return provider.baseUrl;
}

/** "provider/modelId" → "modelId". */
export function extractModelId(providerSlashModel: string): string {
  const slash = providerSlashModel.indexOf("/");
  return slash > 0 ? providerSlashModel.slice(slash + 1) : providerSlashModel;
}

/**
 * Per plan PE Skeptic Round-1 LOW (line 1304): refuse to start if the Studio
 * URL points at a non-loopback address. We accept localhost / 127.0.0.1 /
 * ::1 only.
 */
export function assertLoopbackUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new DaemonBootError(
      `Studio URL is not a valid URL: ${rawUrl} (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
  const host = parsed.hostname;
  const ok =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1";
  if (!ok) {
    throw new DaemonBootError(
      `Studio URL must be loopback (localhost/127.0.0.1/::1); got '${host}'. Refusing to expose a remote backend behind a local daemon.`
    );
  }
}

interface StudioWaitOpts {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  fetchFn: typeof fetch;
  logger: OperatorLogger;
}

/**
 * Phase 4.4: poll `<baseUrl>/api/inference/status` until the response's
 * `loaded[]` includes the configured model id. Surfaces "studio up, model
 * not loaded" diagnostic if the port responds but the model isn't there.
 * Times out after 5 minutes total.
 */
// When PI_COMMS_DEFAULT_MODEL ends with "/auto", the daemon accepts whatever
// model Studio currently has loaded rather than requiring a specific ID.
const AUTO_MODEL = "auto";

async function waitForStudioModelLoaded(opts: StudioWaitOpts): Promise<string> {
  const deadline = Date.now() + STUDIO_MODEL_WAIT_MS;
  // The /api/inference/status endpoint lives at the Studio root, not under
  // /v1. baseUrl is typically "http://localhost:8888/v1"; trim that suffix
  // before composing.
  const root = opts.baseUrl.replace(/\/v1\/?$/, "");
  const statusUrl = `${root}/api/inference/status`;
  const isAuto = opts.modelId === AUTO_MODEL;

  let attempt = 0;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await opts.fetchFn(statusUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${opts.apiKey}` },
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        opts.logger.error("studio_health_fail", {
          attempt,
          status: res.status,
        });
      } else {
        const body = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const loaded = Array.isArray(body.loaded)
          ? (body.loaded as unknown[]).map((v) => String(v))
          : [];
        const matched = isAuto ? loaded[0] : (loaded.includes(opts.modelId) ? opts.modelId : undefined);
        if (matched) {
          opts.logger.info("studio_health_ok", {
            attempt,
            model: matched,
            ...(isAuto && { auto_detected: true }),
          });
          return matched;
        }
        lastError = isAuto
          ? "studio up, no model loaded yet"
          : `studio up, model '${opts.modelId}' not loaded (loaded=${
              loaded.length === 0 ? "none" : loaded.join(",")
            })`;
        opts.logger.error("studio_health_fail", {
          attempt,
          reason: "model_not_loaded",
          loaded: loaded.length === 0 ? "none" : loaded.join(","),
        });
      }
    } catch (err) {
      lastError =
        err instanceof Error ? err.message : String(err);
      opts.logger.error("studio_health_fail", {
        attempt,
        reason: "fetch_failed",
        error: lastError,
      });
    }
    await sleep(STUDIO_MODEL_POLL_MS);
  }
  throw new DaemonBootError(
    `Studio readiness check timed out after ${STUDIO_MODEL_WAIT_MS / 1000}s: ${
      lastError ?? "no response"
    }`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * One-shot Studio model-loaded probe used by the SessionManager
 * cold-start suppression hook (Pitfall #20 / FIX-B-1 #4).  Identical
 * shape to `waitForStudioModelLoaded` but returns boolean rather than
 * throwing — the caller wants a yes/no, not a wait.
 */
interface StudioProbeOpts {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  fetchFn: typeof fetch;
}

/**
 * Lightweight "what models are loaded in Studio right now" probe.
 *
 * Used by SessionManager.checkForStudioModelSwap (per-inbound, fire-and-forget).
 * Hardening per PE Skeptic W5: explicit AbortSignal.timeout(2000) so a hung
 * Studio doesn't pile up phantom requests in the daemon's event loop.
 *
 * Returns the loaded[] array verbatim (typically length 1, but Studio
 * supports multi-load) or null on any failure (timeout, network, parse).
 * Never throws.
 */
export async function getStudioLoadedModelIds(opts: {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<readonly string[] | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2000;
  try {
    // Strip /v1 suffix if present — /api/inference/status lives at Studio root,
    // not under /v1.  Matches the existing pattern in waitForStudioModelLoaded
    // and probeStudioModelLoaded.
    const root = opts.baseUrl.replace(/\/v1\/?$/, "");
    const url = `${root}/api/inference/status`;
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { loaded?: unknown };
    if (!Array.isArray(body.loaded)) return null;
    return body.loaded.filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
  } catch {
    // SECURITY: do NOT log the caught error — fetch error chains may include
    // URL+method but we keep silence to avoid any chance of accidentally
    // serializing the Authorization header out of an undici internal field.
    // Per Security Elder W2.
    return null;
  }
}

async function probeStudioModelLoaded(
  opts: StudioProbeOpts,
): Promise<boolean> {
  const ids = await getStudioLoadedModelIds({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    fetchFn: opts.fetchFn,
  });
  if (ids === null) return false;
  return opts.modelId === AUTO_MODEL ? ids.length > 0 : ids.includes(opts.modelId);
}

/**
 * Surface helper: pull the current taskId from a TaskStateManager
 * without forcing the caller to widen the discriminated union.  Used
 * by the SessionAckTracker tool-derived rule check on every /unsand.
 */
function getCurrentTaskIdFromState(
  ts: TaskStateManager,
): string | null {
  const s = ts.get();
  if (s.kind === "running" || s.kind === "backgrounded") return s.taskId;
  return null;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

function installSignalHandlers(
  handle: RunningDaemon,
  logger: OperatorLogger,
  exitOnShutdown: boolean
): void {
  const onSignal = (signal: NodeJS.Signals) => {
    logger.info("daemon_shutdown", { signal });
    void handle.shutdown(`signal:${signal}`).then(() => {
      if (exitOnShutdown) process.exit(0);
    });
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  // SIGHUP doesn't exist on Windows; guard the install.
  if (platform() !== "win32") {
    process.once("SIGHUP", () => onSignal("SIGHUP"));
  }
}

// ---------------------------------------------------------------------------
// Filesystem + token + salt helpers
// ---------------------------------------------------------------------------

async function ensureSecureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is masked by process umask on POSIX; an explicit chmod
  // catches the umask=022 case where the dir lands at 0o755.
  try {
    await chmod(path, 0o700);
  } catch {
    /* Windows or filesystems where chmod is advisory; safe to ignore */
  }
}

/**
 * Per FIX-B-2 #4: structured return value so the boot path can emit a
 * forensic `audit_log_corruption_detected` row when parse fails BEFORE we
 * silently regen the salt.  `corruption` is `undefined` when the file was
 * absent (cold-start case) or already valid — only set when the file existed
 * AND failed to parse / failed schema validation.
 */
interface InstallSaltResult {
  salt: string;
  corruption?: { errorClass: string; message: string };
}

async function ensureInstallSalt(home: string): Promise<InstallSaltResult> {
  const path = join(home, "install.json");
  let corruption: InstallSaltResult["corruption"];
  try {
    const raw = await readFile(path, "utf8");
    try {
      const data = JSON.parse(raw) as { install_salt?: string };
      if (
        data.install_salt &&
        typeof data.install_salt === "string" &&
        data.install_salt.length >= 16
      ) {
        return { salt: data.install_salt };
      }
      // File parsed but the salt is missing/short — treat as corruption so
      // the regen is auditable.  Without this branch the daemon would
      // silently rotate the salt and break sender_id_hash continuity for
      // every conversation in the audit log.
      corruption = {
        errorClass: "InvalidInstallSalt",
        message: `install.json present but install_salt missing or shorter than 16 chars`,
      };
    } catch (parseErr) {
      corruption = {
        errorClass:
          parseErr instanceof Error ? parseErr.constructor.name : "ParseError",
        message: parseErr instanceof Error ? parseErr.message : String(parseErr),
      };
    }
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      // A read failure other than "file does not exist" is an ambient FS
      // problem, not a corrupt-file event.  Mark it so the boot path
      // surfaces it via the corruption audit row.
      corruption = {
        errorClass: err.constructor.name,
        message: err.message,
      };
    }
    // ENOENT is the cold-start path — no corruption row, just regen below.
  }

  const salt = randomBytes(32).toString("hex");
  const payload = JSON.stringify(
    { install_salt: salt, created_at: new Date().toISOString() },
    null,
    2,
  );
  await writeFile(path, payload, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    /* best-effort on Windows */
  }
  return { salt, corruption };
}

// ---------------------------------------------------------------------------
// Default socket / pipe path
// ---------------------------------------------------------------------------

function defaultSocketPath(home: string): string {
  if (platform() === "win32") {
    return "\\\\.\\pipe\\pi-comms";
  }
  return join(home, "daemon.sock");
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

/** Allow `tsx src/daemon.ts` to start the daemon directly. */
async function main(): Promise<void> {
  try {
    await start({ exitOnShutdown: true });
  } catch (err) {
    if (
      err instanceof ConfigurationError ||
      err instanceof ModelsJsonValidationError ||
      err instanceof DaemonBootError
    ) {
      console.error(`[pi-comms] boot failed: ${err.message}`);
      process.exit(2);
    }
    console.error("[pi-comms] unexpected boot crash:", err);
    process.exit(1);
  }
}

// Detect "ran via tsx/node" rather than imported (under vitest, daemon.ts is
// imported by tests; we must not auto-start in that case).
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1] ?? "";
    return argv1.endsWith("daemon.ts") || argv1.endsWith("daemon.js");
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void main();
}

/** Re-export for convenience. */
export { start as startDaemon };

// Re-export helpers tests want to assert against directly.
export { homedir as _homedir };
