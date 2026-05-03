/**
 * Tests for `src/lib/sdk-models-validator.ts`.
 *
 * Per IMPL-15 brief (≥6 cases): validate the zod schema accepts realistic
 * pi-mono ≥0.70 shapes and rejects every shape the plan §"Schema-drift
 * detection" calls out (missing `api`, `apiKey`, `authHeader`, `input`,
 * `cost`).
 */

import { describe, expect, test } from "vitest";

import {
  ModelsJsonValidationError,
  loadAndValidateModelsJson,
  validateModelsJson,
} from "../src/lib/sdk-models-validator.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validModelEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "unsloth/Qwen3.6-27B-GGUF",
    name: "Qwen 3.6",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 1024,
    ...overrides,
  };
}

function validProvider(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://localhost:8888/v1",
    api: "openai-completions",
    apiKey: "spike-key",
    authHeader: true,
    models: [validModelEntry()],
    ...overrides,
  };
}

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    providers: { "unsloth-studio": validProvider() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateModelsJson", () => {
  test("accepts a minimal valid pi-mono ≥0.70 config", () => {
    const cfg = validConfig();
    const result = validateModelsJson(cfg);
    expect(result.providers["unsloth-studio"]).toBeDefined();
    expect(result.providers["unsloth-studio"].models).toHaveLength(1);
  });

  test("accepts multi-provider + multi-model configurations (passthrough)", () => {
    const cfg = validConfig({
      providers: {
        "unsloth-studio": validProvider(),
        "ollama-localhost": {
          baseUrl: "http://localhost:11434",
          api: "ollama",
          apiKey: "no-key",
          authHeader: false,
          models: [
            validModelEntry({ id: "qwen3:14b" }),
            validModelEntry({ id: "qwen3:32b" }),
          ],
        },
      },
    });
    const result = validateModelsJson(cfg);
    expect(Object.keys(result.providers)).toEqual([
      "unsloth-studio",
      "ollama-localhost",
    ]);
  });

  test("rejects when providers map is empty", () => {
    expect(() => validateModelsJson({ providers: {} })).toThrow(
      ModelsJsonValidationError
    );
  });

  test("rejects when api field is missing on provider", () => {
    const cfg = validConfig({
      providers: {
        bad: { ...validProvider(), api: undefined },
      },
    });
    try {
      validateModelsJson(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelsJsonValidationError);
      const issues = (err as ModelsJsonValidationError).issues.join(" ");
      expect(issues).toMatch(/api/);
    }
  });

  test("rejects when apiKey field is missing on provider", () => {
    const cfg = validConfig({
      providers: {
        bad: { ...validProvider(), apiKey: undefined },
      },
    });
    try {
      validateModelsJson(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelsJsonValidationError);
      const issues = (err as ModelsJsonValidationError).issues.join(" ");
      expect(issues).toMatch(/apiKey/);
    }
  });

  test("rejects when authHeader is not a boolean", () => {
    const cfg = validConfig({
      providers: {
        bad: { ...validProvider(), authHeader: "yes" },
      },
    });
    try {
      validateModelsJson(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelsJsonValidationError);
      const issues = (err as ModelsJsonValidationError).issues.join(" ");
      expect(issues).toMatch(/authHeader/);
    }
  });

  test("rejects when a model entry omits `input`", () => {
    const cfg = validConfig({
      providers: {
        "unsloth-studio": {
          ...validProvider(),
          models: [{ id: "x", cost: { input: 0, output: 0 } }],
        },
      },
    });
    expect(() => validateModelsJson(cfg)).toThrow(ModelsJsonValidationError);
  });

  test("rejects when a model entry omits `cost`", () => {
    const cfg = validConfig({
      providers: {
        "unsloth-studio": {
          ...validProvider(),
          models: [{ id: "x", input: ["text"] }],
        },
      },
    });
    expect(() => validateModelsJson(cfg)).toThrow(ModelsJsonValidationError);
  });

  test("ModelsJsonValidationError surfaces structured issues array", () => {
    const cfg = validConfig({
      providers: {
        // Doubly bad: missing api AND models is empty
        bad: { apiKey: "k", authHeader: true, models: [] },
      },
    });
    try {
      validateModelsJson(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelsJsonValidationError);
      const e = err as ModelsJsonValidationError;
      expect(e.issues.length).toBeGreaterThanOrEqual(1);
      // Issues array MUST be a real list — callers grep it for diagnostics.
      expect(Array.isArray(e.issues)).toBe(true);
    }
  });

  test("unknown extra fields pass through (forward-compat)", () => {
    const cfg = validConfig({
      providers: {
        "unsloth-studio": validProvider({
          someFutureField: "value",
          anotherOne: 42,
        }),
      },
    });
    expect(() => validateModelsJson(cfg)).not.toThrow();
  });
});

describe("loadAndValidateModelsJson", () => {
  test("returns parsed config when reader returns valid JSON", async () => {
    const cfg = validConfig();
    const reader = async () => JSON.stringify(cfg);
    const result = await loadAndValidateModelsJson("/fake/path.json", reader);
    expect(result.providers["unsloth-studio"].models[0].id).toBe(
      "unsloth/Qwen3.6-27B-GGUF"
    );
  });

  test("throws ModelsJsonValidationError on JSON parse failure", async () => {
    const reader = async () => "{ this is not json";
    await expect(
      loadAndValidateModelsJson("/fake/path.json", reader)
    ).rejects.toBeInstanceOf(ModelsJsonValidationError);
  });

  test("throws ModelsJsonValidationError on reader I/O failure", async () => {
    const reader = async () => {
      throw new Error("ENOENT: no such file");
    };
    await expect(
      loadAndValidateModelsJson("/fake/path.json", reader)
    ).rejects.toBeInstanceOf(ModelsJsonValidationError);
  });
});
