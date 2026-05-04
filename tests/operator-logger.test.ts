import { describe, expect, it } from "vitest";
import {
  createOperatorLogger,
  noopOperatorLogger,
  type OperatorLogger,
  type OperatorLoggerOptions,
} from "../src/utils/operator-logger.js";

interface Captured {
  lines: string[];
  logger: OperatorLogger;
}

function capture(overrides: Partial<OperatorLoggerOptions> = {}): Captured {
  const lines: string[] = [];
  const opts: OperatorLoggerOptions = {
    level: "info",
    style: "pretty",
    includeContent: false,
    previewChars: 20,
    write: (line) => lines.push(line),
    ...overrides,
  };
  return { lines, logger: createOperatorLogger(opts) };
}

describe("operator-logger — level filtering", () => {
  it("silent suppresses info/debug/error/banner", () => {
    const { lines, logger } = capture({ level: "silent" });
    logger.info("chat_request", { chat: 1 });
    logger.debug("tool_start", { name: "ReadFile" });
    logger.error("chat_error", { chat: 1 });
    logger.banner({ bot: "@pi" });
    expect(lines).toEqual([]);
  });

  it("info suppresses debug events but emits info and error", () => {
    const { lines, logger } = capture({ level: "info" });
    logger.info("chat_request", { chat: 1 });
    logger.debug("tool_start", { name: "ReadFile" });
    logger.error("chat_error", { chat: 1 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("chat request");
    expect(lines[1]).toContain("chat error");
  });

  it("debug emits info, debug, and error events", () => {
    const { lines, logger } = capture({ level: "debug" });
    logger.info("chat_request", { chat: 1 });
    logger.debug("tool_start", { name: "ReadFile" });
    logger.error("chat_error", { chat: 1 });
    expect(lines).toHaveLength(3);
  });
});

describe("operator-logger — style rendering", () => {
  it("pretty includes timestamp HH:MM:SS, icon, and label", () => {
    const { lines, logger } = capture({ style: "pretty" });
    logger.info("daemon_boot", { mode: "yolo" });
    expect(lines).toHaveLength(1);
    // GB locale gives HH:MM:SS form
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\s+/);
    expect(lines[0]).toContain("🟢");
    expect(lines[0]).toContain("daemon boot");
    expect(lines[0]).toContain("mode=yolo");
  });

  it("plain renders as `[severity] event field=value` without timestamp/icon", () => {
    const { lines, logger } = capture({ style: "plain" });
    logger.info("tell_emit", { chat: 42 });
    expect(lines[0]).toBe("[info] tell_emit chat=42");
    logger.error("classifier_block", { rule: "rm" });
    expect(lines[1]).toBe("[error] classifier_block rule=rm");
  });

  it("json emits a single parseable JSON object per call with ts/level/event", () => {
    const { lines, logger } = capture({ style: "json" });
    logger.info("confirm_request", { id: "c-1", chat: 7 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe("confirm_request");
    expect(parsed.level).toBe("info");
    expect(parsed.id).toBe("c-1");
    expect(parsed.chat).toBe(7);
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/T.*Z$/);
  });
});

describe("operator-logger — preview() and includeContent", () => {
  it("preview() with includeContent=false truncates long values with ellipsis", () => {
    const { logger } = capture({ includeContent: false, previewChars: 10 });
    expect(logger.includeContent).toBe(false);
    const out = logger.preview("the quick brown fox jumps over the lazy dog");
    expect(out).toBeDefined();
    expect(out!.length).toBe(10);
    // last char is the single-char ellipsis
    expect(out!.endsWith("…")).toBe(true);
    expect(out!.startsWith("the quick")).toBe(true);
  });

  it("preview() with includeContent=true returns the full normalized string", () => {
    const { logger } = capture({ includeContent: true, previewChars: 10 });
    const original = "the quick   brown\nfox jumps over the lazy dog";
    const out = logger.preview(original);
    // whitespace gets compacted but no truncation when includeContent=true
    expect(out).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("preview() returns undefined for undefined/empty input", () => {
    const { logger } = capture();
    expect(logger.preview(undefined)).toBeUndefined();
    expect(logger.preview("")).toBeUndefined();
  });

  it("preview() returns the compacted string unchanged when within previewChars", () => {
    const { logger } = capture({ includeContent: false, previewChars: 50 });
    expect(logger.preview("hello world")).toBe("hello world");
  });
});

describe("operator-logger — banner()", () => {
  it("pretty banner uses pi-comms header and 5 framed lines (incl. v0.2.2 diagnostic-mode tip)", () => {
    const { lines, logger } = capture({ style: "pretty" });
    logger.banner({
      bot: "@pi_bot",
      mode: "YOLO",
      workers: "0/1",
      model: "qwen3-coder",
      sessions: "shared",
      extensions: "0",
    });
    // v0.2.2 added a 5th line — the diagnostic-mode tip per UX BLESS-W6 +
    // Observability BLESS-W8.  Operators staring at the log must be able
    // to discover OPERATOR_LOG_LEVEL=debug without reading INSTALL.md.
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("pi-comms online");
    expect(lines[0]).not.toContain("Gemini Claw");
    expect(lines[1]).toContain("bot=@pi_bot");
    expect(lines[1]).toContain("mode=YOLO");
    expect(lines[1]).toContain("workers=0/1");
    expect(lines[2]).toContain("model=qwen3-coder");
    expect(lines[2]).toContain("sessions=shared");
    expect(lines[2]).toContain("ext=0");
    expect(lines[3]).toContain("OPERATOR_LOG_LEVEL=debug");
    expect(lines[3]).toContain("diagnostic mode");
    expect(lines[4].startsWith("╰")).toBe(true);
  });

  it("plain banner emits a single startup line; json banner emits one object", () => {
    const plain = capture({ style: "plain" });
    plain.logger.banner({ bot: "@pi_bot" });
    expect(plain.lines).toHaveLength(1);
    expect(plain.lines[0]).toBe("[info] startup bot=@pi_bot");

    const json = capture({ style: "json" });
    json.logger.banner({ bot: "@pi_bot" });
    expect(json.lines).toHaveLength(1);
    const parsed = JSON.parse(json.lines[0]);
    expect(parsed.event).toBe("startup");
    expect(parsed.bot).toBe("@pi_bot");
  });

  it("silent banner emits nothing", () => {
    const { lines, logger } = capture({ style: "pretty", level: "silent" });
    logger.banner({ bot: "@pi_bot" });
    expect(lines).toEqual([]);
  });
});

describe("operator-logger — noopOperatorLogger", () => {
  it("swallows every call and returns undefined from preview()", () => {
    expect(noopOperatorLogger.includeContent).toBe(false);
    expect(noopOperatorLogger.preview("anything")).toBeUndefined();
    // None of these should throw or write anywhere
    expect(() => noopOperatorLogger.banner({ bot: "@pi" })).not.toThrow();
    expect(() => noopOperatorLogger.info("daemon_boot", { mode: "yolo" })).not.toThrow();
    expect(() => noopOperatorLogger.debug("tool_start", { name: "ReadFile" })).not.toThrow();
    expect(() => noopOperatorLogger.error("chat_error", { chat: 1 })).not.toThrow();
  });
});

describe("operator-logger — pi-comms icon vocabulary", () => {
  it("renders pi-comms-specific icons (daemon_boot, tell_emit, confirm_request, classifier_block, pi_heartbeat)", () => {
    const { lines, logger } = capture({ style: "pretty" });
    logger.info("daemon_boot", {});
    logger.info("tell_emit", {});
    logger.info("confirm_request", {});
    logger.info("classifier_block", {});
    logger.info("pi_heartbeat", {});
    expect(lines[0]).toContain("🟢");
    expect(lines[1]).toContain("📱");
    expect(lines[2]).toContain("❓");
    expect(lines[3]).toContain("🛡️");
    expect(lines[4]).toContain("💓");
  });

  it("falls back to • for info events with unknown event names and ⚠️ for unknown error events", () => {
    const { lines, logger } = capture({ style: "pretty" });
    logger.info("never_registered_event", {});
    logger.error("also_never_registered", {});
    expect(lines[0]).toContain("•");
    expect(lines[1]).toContain("⚠️");
  });
});

describe("operator-logger — field formatting", () => {
  it("compacts undefined/null fields and quotes strings containing spaces", () => {
    const { lines, logger } = capture({ style: "plain" });
    logger.info("chat_request", {
      chat: 1,
      missing: undefined,
      empty: null,
      preview: "hello world",
    });
    // undefined and null should not appear
    expect(lines[0]).not.toContain("missing");
    expect(lines[0]).not.toContain("empty");
    // strings with spaces are JSON-quoted
    expect(lines[0]).toContain('preview="hello world"');
    // simple string/number passes through
    expect(lines[0]).toContain("chat=1");
  });

  it("renders array fields as comma-joined and 'none' when empty", () => {
    const { lines, logger } = capture({ style: "plain" });
    logger.info("subagent", { tools: ["ReadFile", "Write"] });
    logger.info("subagent", { tools: [] });
    expect(lines[0]).toContain("tools=ReadFile,Write");
    expect(lines[1]).toContain("tools=none");
  });
});
