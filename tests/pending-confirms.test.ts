/**
 * Tests for `src/tools/pending-confirms.ts`.
 *
 * Coverage targets (per IMPL-7 brief, ≥8 cases):
 *   - create returns 4-char base32 id with allowed alphabet
 *   - resolve(id, 'yes') resolves promise to true; resolve(id, 'no') → false
 *   - expire fires for past-expiresAt entries; returns expired list;
 *     promises resolve to false
 *   - list with no filter returns all; with taskId filter returns matching
 *   - resolveMostRecent: 0 pending → resolved=false; 1 → resolves;
 *     2+ → ambiguous=true, doesn't resolve
 *   - ID-collide retry works (seeded random)
 *   - clear() resolves all to false
 *
 * Per plan §"v4.2 confirm() semantics" (lines 1118-1141).
 */

import { describe, expect, test } from "vitest";

import {
  ALLOWED_ID_ALPHABET,
  PendingConfirmsRegistry,
} from "../src/tools/pending-confirms.js";

function makeReg(rngSequence?: number[]): PendingConfirmsRegistry {
  // Optional seeded RNG. Each call to next() returns the next value (clamped
  // to [0, 1)). When the sequence is exhausted, falls back to Math.random
  // so collision-retry tests can exhaust their colliding values then succeed.
  if (!rngSequence) return new PendingConfirmsRegistry();
  let i = 0;
  const rng = (): number => {
    if (i < rngSequence.length) {
      const v = rngSequence[i];
      i += 1;
      return v;
    }
    return Math.random();
  };
  return new PendingConfirmsRegistry({ rng });
}

describe("PendingConfirmsRegistry.create()", () => {
  test("returns a 4-char id from the allowed base32 alphabet", () => {
    const reg = makeReg();
    const { id } = reg.create({
      taskId: "T1",
      question: "delete?",
      rationale: "looks unused",
      risk: "low",
      channel: "telegram",
    });
    expect(id).toHaveLength(4);
    for (const ch of id) {
      expect(ALLOWED_ID_ALPHABET).toContain(ch);
    }
  });

  test("alphabet excludes 0/O/1/I/L (anti-confusion)", () => {
    expect(ALLOWED_ID_ALPHABET).not.toContain("0");
    expect(ALLOWED_ID_ALPHABET).not.toContain("O");
    expect(ALLOWED_ID_ALPHABET).not.toContain("1");
    expect(ALLOWED_ID_ALPHABET).not.toContain("I");
    expect(ALLOWED_ID_ALPHABET).not.toContain("L");
  });

  test("returns a promise that resolves to true on /confirm yes", async () => {
    const reg = makeReg();
    const { id, promise } = reg.create({
      taskId: "T1",
      question: "delete?",
      rationale: "...",
      risk: "low",
      channel: "telegram",
    });
    const found = reg.resolve(id, "yes");
    expect(found).toBe(true);
    await expect(promise).resolves.toBe(true);
  });

  test("returns a promise that resolves to false on /confirm no", async () => {
    const reg = makeReg();
    const { id, promise } = reg.create({
      taskId: "T1",
      question: "delete?",
      rationale: "...",
      risk: "low",
      channel: "telegram",
    });
    expect(reg.resolve(id, "no")).toBe(true);
    await expect(promise).resolves.toBe(false);
  });

  test("resolve() returns false for unknown id (does not throw)", () => {
    const reg = makeReg();
    expect(reg.resolve("ZZZZ", "yes")).toBe(false);
  });

  test("resolving an already-resolved id is a no-op (returns false)", async () => {
    const reg = makeReg();
    const { id, promise } = reg.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    expect(reg.resolve(id, "yes")).toBe(true);
    await promise;
    expect(reg.resolve(id, "no")).toBe(false);
  });
});

describe("PendingConfirmsRegistry.list() + filter", () => {
  test("list() with no filter returns all pending entries", () => {
    const reg = makeReg();
    reg.create({
      taskId: "A",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    reg.create({
      taskId: "B",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "whatsapp",
    });
    expect(reg.list()).toHaveLength(2);
  });

  test("list(taskId) returns only entries for that task", () => {
    const reg = makeReg();
    reg.create({
      taskId: "A",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    reg.create({
      taskId: "B",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    reg.create({
      taskId: "A",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const onlyA = reg.list("A");
    expect(onlyA).toHaveLength(2);
    for (const c of onlyA) expect(c.taskId).toBe("A");
  });
});

describe("PendingConfirmsRegistry.resolveMostRecent()", () => {
  test("returns resolved=false when nothing is pending", () => {
    const reg = makeReg();
    const r = reg.resolveMostRecent("yes");
    expect(r.resolved).toBe(false);
    expect(r.ambiguous).toBe(false);
  });

  test("resolves the only pending confirm when exactly one is pending", async () => {
    const reg = makeReg();
    const { promise } = reg.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const r = reg.resolveMostRecent("yes");
    expect(r.resolved).toBe(true);
    expect(r.ambiguous).toBe(false);
    await expect(promise).resolves.toBe(true);
  });

  test("returns ambiguous=true and resolves nothing when 2+ are pending", async () => {
    const reg = makeReg();
    const a = reg.create({
      taskId: "A",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const b = reg.create({
      taskId: "B",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const r = reg.resolveMostRecent("yes");
    expect(r.resolved).toBe(false);
    expect(r.ambiguous).toBe(true);
    // Both promises remain unresolved; clean up by explicit resolve so
    // vitest's leak detector doesn't complain.
    reg.resolve(a.id, "no");
    reg.resolve(b.id, "no");
    await Promise.all([a.promise, b.promise]);
  });
});

describe("PendingConfirmsRegistry.expire()", () => {
  test("expires entries past expiresAt and resolves their promises to false", async () => {
    const reg = makeReg();
    const { id, promise } = reg.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
      ttlMs: 1, // expire after 1ms
    });
    // Future "now" — well past the entry's expiresAt.
    const expired = reg.expire(Date.now() + 60_000);
    expect(expired).toHaveLength(1);
    expect(expired[0].shortId).toBe(id);
    await expect(promise).resolves.toBe(false);
    // Subsequent expire() returns nothing.
    expect(reg.expire(Date.now() + 60_000)).toHaveLength(0);
  });

  test("does not expire entries within their TTL", () => {
    const reg = makeReg();
    reg.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
      ttlMs: 60_000, // 1 minute
    });
    // "now" is barely past creation — well within the window.
    expect(reg.expire(Date.now() + 1_000)).toHaveLength(0);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("PendingConfirmsRegistry — id collision retry", () => {
  test("re-rolls when the generator emits a colliding id", async () => {
    // We seed the RNG so the first 4 chars of the FIRST id come out as
    // the same 4 chars the SECOND id tries first. The retry path must
    // produce a distinct, valid id rather than throw or duplicate.
    //
    // Each of the 32 alphabet positions occupies 1/32 of [0,1).
    // We pick char index 0 ('A') four times in a row to get id 'AAAA'.
    const aaaaSeed = [0, 0, 0, 0];
    const collideThenSucceed = [
      ...aaaaSeed, // first create() -> 'AAAA'
      ...aaaaSeed, // second create() first attempt -> 'AAAA' (collision)
      ...[0, 0, 0, 0.999], // retry -> 'AAA' + last alphabet char (e.g. '9')
    ];
    const reg = makeReg(collideThenSucceed);
    const { id: id1 } = reg.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const { id: id2 } = reg.create({
      taskId: "T2",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    expect(id1).toBe("AAAA");
    expect(id2).not.toBe("AAAA");
    expect(id2).toHaveLength(4);
    for (const ch of id2) expect(ALLOWED_ID_ALPHABET).toContain(ch);
  });

  test("throws when collision retries are exhausted", () => {
    // Seed the RNG to always produce 'AAAA' so every retry collides.
    const everZero = (): number => 0;
    const reg = new PendingConfirmsRegistry({ rng: everZero });
    reg.create({
      taskId: "T1",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    expect(() =>
      reg.create({
        taskId: "T2",
        question: "?",
        rationale: "?",
        risk: "low",
        channel: "telegram",
      })
    ).toThrow(/no.*id available|exhausted/i);
  });
});

describe("PendingConfirmsRegistry.clear()", () => {
  test("clear() resolves all pending promises to false and empties the registry", async () => {
    const reg = makeReg();
    const a = reg.create({
      taskId: "A",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    const b = reg.create({
      taskId: "B",
      question: "?",
      rationale: "?",
      risk: "low",
      channel: "telegram",
    });
    reg.clear();
    expect(reg.list()).toHaveLength(0);
    await expect(a.promise).resolves.toBe(false);
    await expect(b.promise).resolves.toBe(false);
  });
});
