import { describe, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConfigurationError, loadConfig } from "../src/config.js";

const VALID_BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "12345:ABC-fake-token",
  TELEGRAM_ALLOWED_USER_IDS: "111,222",
  UNSLOTH_API_KEY: "sk-fake-key",
  PI_COMMS_DEFAULT_MODEL: "unsloth-studio/unsloth/Qwen3.6-27B-GGUF",
} as const;

describe("loadConfig — happy path", () => {
  test("all env vars present + valid → returns AppConfig with parsed values", () => {
    const env = {
      ...VALID_BASE_ENV,
      PI_MODELS_JSON: "/custom/path/models.json",
      PI_COMMS_HOME: "/tmp/pi-comms-test",
      PI_COMMS_WORKSPACE: "/tmp/pi-comms-test/ws",
      OPERATOR_LOG_STYLE: "json",
      OPERATOR_LOG_LEVEL: "debug",
      OPERATOR_LOG_CONTENT: "true",
      OPERATOR_LOG_PREVIEW_CHARS: "200",
      PI_COMMS_AUTO_PROMOTE_MS: "45000",
      PI_COMMS_SANDBOX: "off",
      PI_COMMS_AUDIT_RETENTION_DAYS: "180",
      PI_COMMS_DIAGNOSTIC_MODE: "true",
    };

    const config = loadConfig(env);

    expect(config.telegramBotToken).toBe("12345:ABC-fake-token");
    expect(Array.from(config.telegramAllowedUserIds).sort()).toEqual(["111", "222"]);
    expect(config.unslothApiKey).toBe("sk-fake-key");
    expect(config.piCommsDefaultModel).toBe("unsloth-studio/unsloth/Qwen3.6-27B-GGUF");
    expect(config.piModelsJson).toBe("/custom/path/models.json");
    expect(config.piCommsHome).toBe("/tmp/pi-comms-test");
    expect(config.piCommsWorkspace).toBe("/tmp/pi-comms-test/ws");
    expect(config.operatorLogStyle).toBe("json");
    expect(config.operatorLogLevel).toBe("debug");
    expect(config.operatorLogContent).toBe(true);
    expect(config.operatorLogPreviewChars).toBe(200);
    expect(config.piCommsAutoPromoteMs).toBe(45000);
    expect(config.piCommsSandbox).toBe("off");
    expect(config.piCommsAuditRetentionDays).toBe(180);
    expect(config.piCommsDiagnosticMode).toBe(true);
  });
});

describe("loadConfig — defaults", () => {
  test("defaults applied when optional env vars unset", () => {
    const config = loadConfig(VALID_BASE_ENV);

    expect(config.piCommsHome).toBe(join(homedir(), ".pi-comms"));
    expect(config.piCommsWorkspace).toBe(join(homedir(), ".pi-comms", "workspace"));
    expect(config.piModelsJson).toBe(join(homedir(), ".pi", "agent", "models.json"));
    expect(config.operatorLogStyle).toBe("pretty");
    expect(config.operatorLogLevel).toBe("info");
    expect(config.operatorLogContent).toBe(false);
    expect(config.operatorLogPreviewChars).toBe(120);
    expect(config.piCommsAutoPromoteMs).toBe(30000);
    expect(config.piCommsSandbox).toBe("on");
    expect(config.piCommsAuditRetentionDays).toBe(90);
    expect(config.piCommsDiagnosticMode).toBe(false);
    expect(config.whatsapp).toBeUndefined();
  });

  test("PI_COMMS_HOME override cascades into default workspace path", () => {
    const config = loadConfig({
      ...VALID_BASE_ENV,
      PI_COMMS_HOME: "/var/lib/pi-comms",
    });

    expect(config.piCommsHome).toBe("/var/lib/pi-comms");
    expect(config.piCommsWorkspace).toBe("/var/lib/pi-comms/workspace");
  });

  test("PI_COMMS_HOME override; explicit PI_COMMS_WORKSPACE wins over cascade", () => {
    const config = loadConfig({
      ...VALID_BASE_ENV,
      PI_COMMS_HOME: "/var/lib/pi-comms",
      PI_COMMS_WORKSPACE: "/elsewhere/work",
    });

    expect(config.piCommsHome).toBe("/var/lib/pi-comms");
    expect(config.piCommsWorkspace).toBe("/elsewhere/work");
  });
});

describe("loadConfig — validation errors", () => {
  test("missing TELEGRAM_BOT_TOKEN throws ConfigurationError", () => {
    const env = { ...VALID_BASE_ENV, TELEGRAM_BOT_TOKEN: "" };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  test("missing UNSLOTH_API_KEY throws ConfigurationError", () => {
    const { UNSLOTH_API_KEY: _drop, ...env } = VALID_BASE_ENV;
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  test("missing PI_COMMS_DEFAULT_MODEL throws ConfigurationError", () => {
    const { PI_COMMS_DEFAULT_MODEL: _drop, ...env } = VALID_BASE_ENV;
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  test("non-numeric TELEGRAM_ALLOWED_USER_IDS throws ConfigurationError", () => {
    const env = { ...VALID_BASE_ENV, TELEGRAM_ALLOWED_USER_IDS: "111,abc,333" };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
    expect(() => loadConfig(env)).toThrow(/abc/);
  });

  test("empty TELEGRAM_ALLOWED_USER_IDS throws ConfigurationError", () => {
    const env = { ...VALID_BASE_ENV, TELEGRAM_ALLOWED_USER_IDS: "" };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  test("invalid OPERATOR_LOG_STYLE throws ConfigurationError", () => {
    const env = { ...VALID_BASE_ENV, OPERATOR_LOG_STYLE: "fancy" };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  test("invalid PI_COMMS_SANDBOX throws ConfigurationError", () => {
    const env = { ...VALID_BASE_ENV, PI_COMMS_SANDBOX: "maybe" };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  test("invalid boolean for OPERATOR_LOG_CONTENT throws ConfigurationError", () => {
    const env = { ...VALID_BASE_ENV, OPERATOR_LOG_CONTENT: "perhaps" };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  test("ConfigurationError has stable .name = 'ConfigurationError' for catch-by-name", () => {
    let caughtName: string | undefined;
    try {
      loadConfig({ ...VALID_BASE_ENV, TELEGRAM_BOT_TOKEN: "" });
    } catch (err) {
      caughtName = (err as Error).name;
    }
    expect(caughtName).toBe("ConfigurationError");
  });
});

describe("loadConfig — WhatsApp identity (Phase 5, optional)", () => {
  test("Model A 'self-chat' parses with owner JID", () => {
    const config = loadConfig({
      ...VALID_BASE_ENV,
      WHATSAPP_IDENTITY_MODEL: "self-chat",
      WHATSAPP_OWNER_JID: "15105551234@s.whatsapp.net",
    });

    expect(config.whatsapp).toBeDefined();
    expect(config.whatsapp?.identityModel).toBe("self-chat");
    expect(config.whatsapp?.ownerJid).toBe("15105551234@s.whatsapp.net");
    expect(config.whatsapp?.botJid).toBeUndefined();
  });

  test("Model B 'second-number' parses with owner + bot JIDs", () => {
    const config = loadConfig({
      ...VALID_BASE_ENV,
      WHATSAPP_IDENTITY_MODEL: "second-number",
      WHATSAPP_OWNER_JID: "15105551234@s.whatsapp.net",
      WHATSAPP_BOT_JID: "15106666666@s.whatsapp.net",
    });

    expect(config.whatsapp).toBeDefined();
    expect(config.whatsapp?.identityModel).toBe("second-number");
    expect(config.whatsapp?.ownerJid).toBe("15105551234@s.whatsapp.net");
    expect(config.whatsapp?.botJid).toBe("15106666666@s.whatsapp.net");
  });

  test("Model A WITHOUT owner JID throws ConfigurationError", () => {
    expect(() =>
      loadConfig({
        ...VALID_BASE_ENV,
        WHATSAPP_IDENTITY_MODEL: "self-chat",
      })
    ).toThrow(ConfigurationError);
  });

  test("Model B WITHOUT bot JID throws ConfigurationError", () => {
    expect(() =>
      loadConfig({
        ...VALID_BASE_ENV,
        WHATSAPP_IDENTITY_MODEL: "second-number",
        WHATSAPP_OWNER_JID: "15105551234@s.whatsapp.net",
      })
    ).toThrow(ConfigurationError);
  });

  test("invalid WHATSAPP_IDENTITY_MODEL value throws ConfigurationError", () => {
    expect(() =>
      loadConfig({
        ...VALID_BASE_ENV,
        WHATSAPP_IDENTITY_MODEL: "telegram-first",
        WHATSAPP_OWNER_JID: "15105551234@s.whatsapp.net",
      })
    ).toThrow(ConfigurationError);
  });
});
