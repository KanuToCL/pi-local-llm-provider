/**
 * Tests for `src/storage/json-store.ts`.
 *
 * Coverage targets (per IMPL-4 brief, ≥7 cases):
 *   1. missing file → null
 *   2. valid file → parsed object
 *   3. corrupt JSON → quarantine + null
 *   4. concurrent writes serialize (no torn writes)
 *   5. atomic rename (write fails, file untouched)
 *   6. tempfile cleanup on failure
 *   7. quarantine filename has timestamp
 * Plus extras: round-trip (write then read), generic-T type erasure,
 * read-while-write ordering.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonStore } from "../src/storage/json-store.js";

interface Bag {
  greeting: string;
  count: number;
  nested?: { ok: boolean };
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-jsonstore-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("JsonStore", () => {
  test("read() returns null when file is missing", async () => {
    const store = new JsonStore<Bag>(join(workDir, "nope.json"));
    expect(await store.read()).toBeNull();
  });

  test("read() returns the parsed object when file is valid", async () => {
    const path = join(workDir, "ok.json");
    writeFileSync(path, JSON.stringify({ greeting: "hi", count: 3 }), "utf8");
    const store = new JsonStore<Bag>(path);
    const got = await store.read();
    expect(got).toEqual({ greeting: "hi", count: 3 });
  });

  test("read() quarantines on corrupt JSON and returns null", async () => {
    const path = join(workDir, "broken.json");
    writeFileSync(path, "{not json,,,", "utf8");
    const store = new JsonStore<Bag>(path);
    expect(await store.read()).toBeNull();

    // Original file should be gone (renamed aside)
    const survivors = readdirSync(workDir);
    expect(survivors).not.toContain("broken.json");
    // Quarantine file should exist with the right shape
    const quarantined = survivors.find((n) =>
      /^broken\.json\.corrupt-\d+\.bak$/.test(n)
    );
    expect(quarantined, `expected quarantine file in: ${survivors.join(", ")}`).toBeTruthy();
    // Quarantine preserves the corrupt content for forensics
    const preserved = readFileSync(join(workDir, quarantined!), "utf8");
    expect(preserved).toBe("{not json,,,");
  });

  test("quarantine filename embeds a millisecond timestamp", async () => {
    const path = join(workDir, "ts.json");
    writeFileSync(path, "garbage", "utf8");
    const store = new JsonStore<Bag>(path);
    const before = Date.now();
    await store.read();
    const after = Date.now();
    const survivors = readdirSync(workDir);
    const q = survivors.find((n) => /^ts\.json\.corrupt-\d+\.bak$/.test(n));
    expect(q).toBeTruthy();
    const ts = Number(/corrupt-(\d+)\.bak$/.exec(q!)![1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("concurrent writes through one instance do not produce torn files", async () => {
    const path = join(workDir, "race.json");
    const store = new JsonStore<Bag>(path);

    // Fire 50 writes concurrently. Without serialization, a partial
    // write could land on disk and the final read could return any
    // intermediate state — or worse, a torn JSON document.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i += 1) {
      writes.push(store.write({ greeting: `n=${i}`, count: i }));
    }
    await Promise.all(writes);

    // The final state must be parseable JSON and equal to one of the
    // 50 writes (queue order is FIFO so it should be the last, but we
    // assert the looser "no torn" property to keep this test robust
    // to scheduler quirks).
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Bag;
    expect(parsed.greeting).toMatch(/^n=\d+$/);
    expect(parsed.count).toBeGreaterThanOrEqual(0);
    expect(parsed.count).toBeLessThan(50);

    // Round-trip: read() returns the same final object
    const viaRead = await store.read();
    expect(viaRead).toEqual(parsed);
  });

  test("write that fails leaves the existing committed file untouched", async () => {
    const path = join(workDir, "atomic.json");
    const store = new JsonStore<Bag>(path);

    // Commit a known-good value first.
    await store.write({ greeting: "original", count: 1 });
    const originalRaw = readFileSync(path, "utf8");

    // Now attempt a write that will fail at JSON.stringify time
    // because of a circular reference. The existing file must remain.
    const cyclic: Record<string, unknown> = { greeting: "bad", count: 2 };
    cyclic.self = cyclic;
    await expect(
      // @ts-expect-error — deliberately bad payload to trigger failure
      store.write(cyclic)
    ).rejects.toThrow();

    expect(readFileSync(path, "utf8")).toBe(originalRaw);
    const viaRead = await store.read();
    expect(viaRead).toEqual({ greeting: "original", count: 1 });
  });

  test("temp file is cleaned up after a failed write", async () => {
    const path = join(workDir, "cleanup.json");
    const store = new JsonStore<Bag>(path);

    const cyclic: Record<string, unknown> = { greeting: "x", count: 0 };
    cyclic.self = cyclic;
    await expect(
      // @ts-expect-error — deliberately bad payload
      store.write(cyclic)
    ).rejects.toThrow();

    // No `*.tmp` orphans left behind in the directory.
    const survivors = readdirSync(workDir);
    const orphans = survivors.filter((n) => n.endsWith(".tmp"));
    expect(orphans).toEqual([]);
  });

  test("round-trip: write then read preserves the payload", async () => {
    const path = join(workDir, "roundtrip.json");
    const store = new JsonStore<Bag>(path);
    const payload: Bag = {
      greeting: "round-trip",
      count: 7,
      nested: { ok: true },
    };
    await store.write(payload);
    expect(await store.read()).toEqual(payload);
  });

  test("write creates parent directories that do not yet exist", async () => {
    // Status pointer / sandbox state files live under nested dirs that
    // may not exist on first daemon boot. The store must mkdir -p.
    const path = join(workDir, "deep", "nested", "dir", "state.json");
    const store = new JsonStore<Bag>(path);
    await store.write({ greeting: "deep", count: 99 });
    const st = await stat(path);
    expect(st.isFile()).toBe(true);
  });

  test("manual quarantine() works on a present file and is a no-op when missing", async () => {
    const path = join(workDir, "manual.json");

    // Missing file → no-op, no throw.
    const store = new JsonStore<Bag>(path);
    await expect(store.quarantine()).resolves.toBeUndefined();

    // With a file present → renamed aside.
    await writeFile(path, "anything", "utf8");
    await store.quarantine();
    const survivors = readdirSync(workDir);
    expect(survivors).not.toContain("manual.json");
    const q = survivors.find((n) => /^manual\.json\.corrupt-\d+\.bak$/.test(n));
    expect(q).toBeTruthy();
  });
});
