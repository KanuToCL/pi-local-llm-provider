// Pi-Comms env-schema-driven config loader.
//
// Pattern lifted from gemini-claw (src/config.ts) per
// ~/.llms/plans/pi_comms_daemon.plan.md §"Lift wholesale (proven patterns)".
// Single source of truth: zod envSchema → safeParse → throw ConfigurationError
// on failure → return typed AppConfig. Type inference flows from here.

import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

// -- Errors -----------------------------------------------------------------

/**
 * Thrown by loadConfig() when env validation fails. Stable .name for
 * catch-by-name across module boundaries (don't rely on instanceof when
 * multiple ConfigurationError classes may exist via dependency duplication).
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

// -- Helpers ----------------------------------------------------------------

/**
 * Parse comma-separated Telegram numeric user IDs into a ReadonlySet<string>.
 * Throws ConfigurationError if any token is non-numeric or the list is empty.
 *
 * Telegram IDs are positive 64-bit ints; we keep them as strings to avoid
 * JS number-precision issues, and accept an optional leading '-' for chat
 * IDs (group/channel IDs are negative in the Telegram API).
 */
export function parseAllowedUserIds(value: string): ReadonlySet<string> {
  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new ConfigurationError(
      "TELEGRAM_ALLOWED_USER_IDS must include at least one Telegram user ID"
    );
  }

  for (const id of ids) {
    if (!/^-?\d+$/.test(id)) {
      throw new ConfigurationError(
        `Invalid Telegram user ID in TELEGRAM_ALLOWED_USER_IDS: ${id}`
      );
    }
  }

  return new Set(ids);
}

/**
 * Parse a string as a boolean. Accepts true/false, 1/0, yes/no, on/off
 * (case-insensitive). Returns defaultValue when value is undefined.
 * Throws ConfigurationError on any other input — fail loud, never guess.
 */
export function asBool(
  value: string | undefined,
  name: string,
  defaultValue = false
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      throw new ConfigurationError(
        `${name} must be a boolean (true/false, 1/0, yes/no, on/off); got: ${value}`
      );
  }
}

// -- Schema -----------------------------------------------------------------

const envSchema = z.object({
  // Telegram channel (Phase 1)
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .trim()
    .min(1, "TELEGRAM_ALLOWED_USER_IDS must include at least one Telegram user ID"),

  // pi-mono / Studio backend
  UNSLOTH_API_KEY: z.string().trim().min(1, "UNSLOTH_API_KEY is required"),
  PI_MODELS_JSON: z.string().trim().optional(),
  PI_COMMS_DEFAULT_MODEL: z
    .string()
    .trim()
    .min(1, "PI_COMMS_DEFAULT_MODEL is required"),

  // Daemon runtime
  PI_COMMS_HOME: z.string().trim().optional(),
  PI_COMMS_WORKSPACE: z.string().trim().optional(),

  // Operator log (mirror gemini-claw)
  OPERATOR_LOG_STYLE: z.enum(["pretty", "plain", "json"]).default("pretty"),
  OPERATOR_LOG_LEVEL: z.enum(["silent", "info", "debug"]).default("info"),
  OPERATOR_LOG_CONTENT: z.string().optional(),
  OPERATOR_LOG_PREVIEW_CHARS: z.coerce.number().int().positive().default(120),

  // Auto-promote threshold (ms): below = sync; above = system promotes to bg
  PI_COMMS_AUTO_PROMOTE_MS: z.coerce.number().int().positive().default(30_000),

  // Sandbox posture: 'on' (default) | 'off' (NOT-RECOMMENDED; use /unsand instead)
  PI_COMMS_SANDBOX: z.enum(["on", "off"]).default("on"),

  // Audit log retention (days)
  PI_COMMS_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  // Diagnostic mode — full prompts/responses to file (24h auto-purge); never console
  PI_COMMS_DIAGNOSTIC_MODE: z.string().optional(),

  // WhatsApp channel (Phase 5) — all optional; presence of WHATSAPP_IDENTITY_MODEL
  // gates whether the WhatsAppConfig is constructed. See §"v4.3 — WhatsApp dual-identity".
  WHATSAPP_IDENTITY_MODEL: z.enum(["self-chat", "second-number"]).optional(),
  WHATSAPP_OWNER_JID: z.string().trim().optional(),
  WHATSAPP_BOT_JID: z.string().trim().optional(),
});

// -- Output types -----------------------------------------------------------

export type OperatorLogStyle = "pretty" | "plain" | "json";
export type OperatorLogLevel = "silent" | "info" | "debug";
export type SandboxPosture = "on" | "off";
export type WhatsAppIdentityModel = "self-chat" | "second-number";

/**
 * WhatsApp dual-identity config (Phase 5). See plan §"v4.3":
 * - Model A "self-chat": pi shares Sergio's WhatsApp identity; bot JID unused.
 * - Model B "second-number": pi has a separate number; bot JID required.
 */
export interface WhatsAppConfig {
  identityModel: WhatsAppIdentityModel;
  /** Sergio's primary number JID. Required for both models. */
  ownerJid: string;
  /** Pi's bot number JID. Required for Model B; absent for Model A. */
  botJid?: string;
}

export interface AppConfig {
  // Telegram
  telegramBotToken: string;
  telegramAllowedUserIds: ReadonlySet<string>;

  // pi-mono backend
  unslothApiKey: string;
  piModelsJson: string;
  piCommsDefaultModel: string;

  // Daemon paths
  piCommsHome: string;
  piCommsWorkspace: string;

  // Operator log
  operatorLogStyle: OperatorLogStyle;
  operatorLogLevel: OperatorLogLevel;
  operatorLogContent: boolean;
  operatorLogPreviewChars: number;

  // Behavior
  piCommsAutoPromoteMs: number;
  piCommsSandbox: SandboxPosture;
  piCommsAuditRetentionDays: number;
  piCommsDiagnosticMode: boolean;

  // WhatsApp (optional; present only when WHATSAPP_IDENTITY_MODEL is set)
  whatsapp?: WhatsAppConfig;
}

// -- Loader -----------------------------------------------------------------

/**
 * Load and validate config from a process env (or any string-keyed map).
 * Defaults follow the .env.example contract:
 *   PI_COMMS_HOME      → ~/.pi-comms
 *   PI_COMMS_WORKSPACE → <PI_COMMS_HOME>/workspace
 *   PI_MODELS_JSON     → ~/.pi/agent/models.json
 *
 * Fails fast with ConfigurationError listing every issue so first-time
 * setup surfaces all problems in one round-trip.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new ConfigurationError(details);
  }

  const data = parsed.data;

  // Path defaults — PI_COMMS_HOME cascades into PI_COMMS_WORKSPACE so a
  // single override moves both. Explicit PI_COMMS_WORKSPACE wins over cascade.
  const piCommsHome = data.PI_COMMS_HOME ?? join(homedir(), ".pi-comms");
  const piCommsWorkspace = data.PI_COMMS_WORKSPACE ?? join(piCommsHome, "workspace");
  const piModelsJson =
    data.PI_MODELS_JSON ?? join(homedir(), ".pi", "agent", "models.json");

  const whatsapp = buildWhatsAppConfig(data);

  return {
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parseAllowedUserIds(data.TELEGRAM_ALLOWED_USER_IDS),

    unslothApiKey: data.UNSLOTH_API_KEY,
    piModelsJson,
    piCommsDefaultModel: data.PI_COMMS_DEFAULT_MODEL,

    piCommsHome,
    piCommsWorkspace,

    operatorLogStyle: data.OPERATOR_LOG_STYLE,
    operatorLogLevel: data.OPERATOR_LOG_LEVEL,
    operatorLogContent: asBool(data.OPERATOR_LOG_CONTENT, "OPERATOR_LOG_CONTENT"),
    operatorLogPreviewChars: data.OPERATOR_LOG_PREVIEW_CHARS,

    piCommsAutoPromoteMs: data.PI_COMMS_AUTO_PROMOTE_MS,
    piCommsSandbox: data.PI_COMMS_SANDBOX,
    piCommsAuditRetentionDays: data.PI_COMMS_AUDIT_RETENTION_DAYS,
    piCommsDiagnosticMode: asBool(
      data.PI_COMMS_DIAGNOSTIC_MODE,
      "PI_COMMS_DIAGNOSTIC_MODE"
    ),

    whatsapp,
  };
}

/**
 * Validate the WhatsApp identity envelope. Returns undefined when the channel
 * is not configured. When configured, enforces the per-model requirements:
 *   - both models require WHATSAPP_OWNER_JID
 *   - Model B (second-number) additionally requires WHATSAPP_BOT_JID
 */
function buildWhatsAppConfig(data: z.infer<typeof envSchema>): WhatsAppConfig | undefined {
  if (data.WHATSAPP_IDENTITY_MODEL === undefined) {
    return undefined;
  }

  if (!data.WHATSAPP_OWNER_JID) {
    throw new ConfigurationError(
      `WHATSAPP_OWNER_JID is required when WHATSAPP_IDENTITY_MODEL=${data.WHATSAPP_IDENTITY_MODEL}`
    );
  }

  if (data.WHATSAPP_IDENTITY_MODEL === "second-number" && !data.WHATSAPP_BOT_JID) {
    throw new ConfigurationError(
      "WHATSAPP_BOT_JID is required when WHATSAPP_IDENTITY_MODEL=second-number"
    );
  }

  return {
    identityModel: data.WHATSAPP_IDENTITY_MODEL,
    ownerJid: data.WHATSAPP_OWNER_JID,
    botJid: data.WHATSAPP_BOT_JID,
  };
}
