import { describe, expect, test } from "vitest";
import { GlobalQueue } from "../src/lib/chat-queue.js";

/** Promise that resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("GlobalQueue", () => {
  test("operations on the same key run serially, never overlap", async () => {
    const q = new GlobalQueue();
    let active = 0;
    let maxObserved = 0;
    const observed: number[] = [];

    const op = async (id: number) => {
      active += 1;
      maxObserved = Math.max(maxObserved, active);
      observed.push(id);
      await sleep(15);
      active -= 1;
      return id;
    };

    const results = await Promise.all([
      q.run("global", () => op(1)),
      q.run("global", () => op(2)),
      q.run("global", () => op(3)),
    ]);

    expect(results).toEqual([1, 2, 3]);
    expect(maxObserved).toBe(1); // strict serialization
    expect(observed).toEqual([1, 2, 3]); // FIFO order
  });

  test("a later call blocks until the prior one resolves", async () => {
    const q = new GlobalQueue();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((r) => (releaseFirst = r));

    const first = q.run("global", async () => {
      order.push("first-start");
      await firstReady;
      order.push("first-end");
    });

    // Give microtasks a chance, then enqueue the second op.
    await sleep(5);
    const second = q.run("global", async () => {
      order.push("second-start");
    });

    // Second must NOT have started yet; first is still pending.
    await sleep(20);
    expect(order).toEqual(["first-start"]);

    // Release first; second should now run to completion.
    releaseFirst();
    await first;
    await second;

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  test("an error in one operation does NOT poison the queue (next op still runs)", async () => {
    const q = new GlobalQueue();
    const ran: string[] = [];

    const failing = q
      .run("global", async () => {
        ran.push("failing");
        throw new Error("boom");
      })
      .catch((e) => `caught:${(e as Error).message}`);

    const next = q.run("global", async () => {
      ran.push("next");
      return "ok";
    });

    expect(await failing).toBe("caught:boom");
    expect(await next).toBe("ok");
    expect(ran).toEqual(["failing", "next"]);
  });

  test("operations on DIFFERENT keys can interleave (per-key isolation preserved)", async () => {
    const q = new GlobalQueue();
    let aActive = 0;
    let bActive = 0;
    let bothActiveSeen = false;

    const op = async (key: "a" | "b") => {
      if (key === "a") aActive += 1;
      else bActive += 1;
      if (aActive > 0 && bActive > 0) bothActiveSeen = true;
      await sleep(20);
      if (key === "a") aActive -= 1;
      else bActive -= 1;
    };

    await Promise.all([
      q.run("a", () => op("a")),
      q.run("b", () => op("b")),
    ]);

    // Different keys SHOULD have been allowed to run concurrently.
    expect(bothActiveSeen).toBe(true);
  });
});
