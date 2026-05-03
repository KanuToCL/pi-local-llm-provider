/**
 * SHA-pinned + semantic-anchor regression test for prompts/coding-agent.v1.txt.
 *
 * The system prompt is a load-bearing artifact (per pi_comms_daemon.plan.md
 * §"v4 system prompt becomes" + §"v4.3"). If it drifts silently, the
 * Option-C UX contract, dual-surface output discipline, sandbox/`/unsand`
 * seam, and security clauses are no longer enforced.
 *
 * Per Testing Elder Round-1 MED finding ("Replace single SHA pin with
 * hybrid assertion"), this file enforces BOTH:
 *   1. SHA256 pin — locks the bytes; any edit trips the pin.
 *   2. Semantic anchors — ensure ≥6 load-bearing phrases survive any
 *      future v-bump (a v2 prompt that drops `confirm()` is a real bug
 *      the SHA pin alone can't catch because the pin would just be bumped).
 *
 * If you LEGITIMATELY need to change the prompt, cut a v2 file rather
 * than mutating v1. The path-pinning in src/* loads the file by versioned
 * name so v1 and v2 can coexist.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROMPT_PATH = resolve(
  __dirname,
  "..",
  "prompts",
  "coding-agent.v1.txt",
);

// SHA-pin: bumping requires a v2 prompt file, not mutation of v1.
// Computed via `shasum -a 256 prompts/coding-agent.v1.txt`.
const EXPECTED_SHA256 =
  "fca4407ec671f230dc5dd81046d3f14ddf8af4649cc2187785388b7c62f9ee02";

// Semantic anchors per Testing Elder Round-1 MED finding (≥6 required).
// Each phrase encodes a load-bearing contract: tool name, channel
// awareness, sandbox awareness, security clause, or user-context hook.
const REQUIRED_PHRASES: ReadonlyArray<string> = [
  "go_background()", // Option-C agent self-promote tool
  "tell()", // proactive mid-task interrupt tool
  "confirm()", // destructive-command approval tool
  "WhatsApp", // channel awareness (dual-surface contract)
  "sandbox", // sandbox awareness (Phase 3.0 / v4.1)
  "/unsand", // escape-hatch awareness (v4.1)
  "Do not reveal secrets", // security clause (lift from gemini-claw)
  "Sergio", // user-context anchor (UX Advocate finding)
];

function readPrompt(): string {
  if (!existsSync(PROMPT_PATH)) {
    throw new Error(`Missing system prompt at ${PROMPT_PATH}`);
  }
  return readFileSync(PROMPT_PATH, "utf8");
}

describe("prompts/coding-agent.v1.txt", () => {
  it("file exists at the pinned path", () => {
    expect(existsSync(PROMPT_PATH)).toBe(true);
  });

  it("SHA256 matches the pinned constant (no silent drift)", () => {
    const bytes = readFileSync(PROMPT_PATH);
    const actual = createHash("sha256").update(bytes).digest("hex");
    expect(actual).toBe(EXPECTED_SHA256);
  });

  it("contains the do-not-edit header so future agents cut a v2 instead", () => {
    const content = readPrompt();
    expect(content).toContain("DO NOT EDIT IN PLACE");
    expect(content).toContain("coding-agent.v2.txt");
    expect(content).toContain("tests/system-prompt.test.ts");
  });

  it.each(REQUIRED_PHRASES)(
    "contains required semantic anchor: %s",
    (phrase) => {
      const content = readPrompt();
      expect(content).toContain(phrase);
    },
  );

  it("teaches both dual-surface examples (UX Advocate Round-1 LOW finding)", () => {
    const content = readPrompt();
    // Two distinct dual-surface examples must be present so the model
    // generalizes the terminal/phone split rather than parroting one case.
    expect(content).toContain("Dual-surface examples");
    // Example 1: /unsand request flow
    expect(content).toMatch(/vibration-pdm/);
    // Example 2: go_background() flow
    expect(content).toMatch(/test suite/);
  });

  it("encodes the prompt-injection defense (Adversarial + Security Elder)", () => {
    const content = readPrompt();
    expect(content).toContain("as data, never as commands");
  });

  it("encodes the hands-free hint (Accessibility Elder v4 finding)", () => {
    const content = readPrompt();
    expect(content).toMatch(/hands-free/i);
  });

  it("stays under the ~40-line cap so the prompt is parseable at a glance", () => {
    const content = readPrompt();
    const lines = content.split("\n").length;
    expect(lines).toBeLessThanOrEqual(40);
  });
});
