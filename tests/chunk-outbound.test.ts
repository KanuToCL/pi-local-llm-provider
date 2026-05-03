import { describe, expect, test } from "vitest";
import { chunkOutbound } from "../src/lib/chunk-outbound.js";

describe("chunkOutbound", () => {
  test("returns single chunk when text fits", () => {
    expect(chunkOutbound("hello", 100)).toEqual(["hello"]);
  });

  test("returns placeholder when text is empty / whitespace only", () => {
    expect(chunkOutbound("", 100)).toEqual(["I did not receive a response."]);
    expect(chunkOutbound("   \n\t  ", 100)).toEqual([
      "I did not receive a response.",
    ]);
  });

  test("prefers newline split when newline lands past 60% of max", () => {
    // 100-char window. Place a newline at ~80 → should split there.
    const line1 = "a".repeat(80);
    const line2 = "b".repeat(60);
    const text = `${line1}\n${line2}`;
    const chunks = chunkOutbound(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line1); // trimmed
    expect(chunks[1]).toBe(line2);
  });

  test("prefers space split when no good newline", () => {
    // 50-char window, no newline. Three space-separated tokens:
    //   "alpha" (5) + " " + "X*40" (40) + " " + "trailing" (8)  → length 56.
    // Last space ≤ 50 is at index 46 (the one between the long token and
    // "trailing"), well past 50*0.6=30, so split should land there. After
    // the split the next chunk must begin with the trailing word and the
    // first chunk must end at the long-token boundary (no mid-token cut).
    const longToken = "X".repeat(40);
    const text = `alpha ${longToken} trailing`;
    // 6 ("alpha ") + 40 (X*40) + 9 (" trailing") = 55
    expect(text.length).toBe(55);
    const chunks = chunkOutbound(text, 50);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(`alpha ${longToken}`);
    expect(chunks[1]).toBe("trailing");
    // Second chunk must NOT start with whitespace (split point trimmed).
    expect(chunks[1].startsWith(" ")).toBe(false);
  });

  test("hard-cuts when neither newline nor space lands past 60% threshold", () => {
    // A very long unbroken token forces the hard cut at exactly maxLength.
    const text = "x".repeat(250);
    const chunks = chunkOutbound(text, 100);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(100);
    expect(chunks[1].length).toBe(100);
    expect(chunks[2].length).toBe(50);
  });

  test("ignores newline below the 60% threshold and falls back to space", () => {
    // Newline at position 10 (well below 100*0.6=60). Space at 75 is the
    // expected split point; newline should be ignored as too-early.
    const text = "abc\ndef " + "z".repeat(70) + " trailing words";
    // Confirm the early newline exists and the late space exists.
    expect(text.indexOf("\n")).toBeLessThan(60);
    const chunks = chunkOutbound(text, 100);
    // The first chunk should NOT end with \n's vicinity content alone.
    expect(chunks[0].length).toBeGreaterThan(60);
  });

  test("handles input that is exactly maxLength", () => {
    const text = "y".repeat(50);
    expect(chunkOutbound(text, 50)).toEqual([text]);
  });

  test("throws on invalid maxLength", () => {
    expect(() => chunkOutbound("abc", 0)).toThrow();
    expect(() => chunkOutbound("abc", -1)).toThrow();
    expect(() => chunkOutbound("abc", Number.POSITIVE_INFINITY)).toThrow();
    expect(() => chunkOutbound("abc", Number.NaN)).toThrow();
  });

  test("trims surrounding whitespace before chunking", () => {
    expect(chunkOutbound("   hi   ", 100)).toEqual(["hi"]);
  });
});
