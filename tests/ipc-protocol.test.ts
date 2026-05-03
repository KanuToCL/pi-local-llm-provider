/**
 * Tests for `src/ipc/protocol.ts`.
 *
 * Coverage targets (≥12 cases per IMPL-13 brief):
 *   1.  AttachReq parses with valid token + stream + clientName
 *   2.  AttachReq rejects when authToken < 8 chars (Pitfall #24 floor)
 *   3.  AttachReq rejects when stream is not 'all' | 'tell-only'
 *   4.  SendReq accepts text within length bounds + rejects empty/oversize
 *   5.  StatusReq parses with no extra fields
 *   6.  HistoryReq accepts limit in [1, 1000]; rejects 0 / 1001 / float
 *   7.  DetachReq parses
 *   8.  ShutdownReq requires authToken
 *   9.  PauseReq / ResumeReq parse
 *   10. PointerWriteReq accepts an arbitrary string body
 *   11. ClientReq rejects an unknown verb
 *   12. ServerResp round-trips event/status/history/ack/error/pointer-write
 *   13. EventResp requires `lag_ms` (Architect Round-1 backpressure field)
 *   14. generateToken returns 64-char hex (32 bytes)
 *   15. ensureTokenFile creates a 0600 file when missing
 *   16. ensureTokenFile returns existing token when present
 *   17. readToken trims trailing whitespace
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttachReq,
  ClientReq,
  DetachReq,
  EventResp,
  HistoryReq,
  PauseReq,
  PointerWriteReq,
  ResumeReq,
  SendReq,
  ServerResp,
  ShutdownReq,
  StatusReq,
  ensureTokenFile,
  generateToken,
  readToken,
} from "../src/ipc/protocol.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-ipc-protocol-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("ClientReq — AttachReq", () => {
  it("accepts a well-formed attach request", () => {
    const out = AttachReq.parse({
      verb: "attach",
      stream: "all",
      authToken: "deadbeefdeadbeef",
      clientName: "pi-comms-cli",
    });
    expect(out.stream).toBe("all");
    expect(out.clientName).toBe("pi-comms-cli");
  });

  it("rejects a too-short authToken (< 8 chars)", () => {
    expect(() =>
      AttachReq.parse({
        verb: "attach",
        stream: "all",
        authToken: "short",
      })
    ).toThrow();
  });

  it("rejects an unknown stream value", () => {
    expect(() =>
      AttachReq.parse({
        verb: "attach",
        stream: "everything",
        authToken: "deadbeefdeadbeef",
      })
    ).toThrow();
  });

  it("rejects clientName longer than 64 chars", () => {
    expect(() =>
      AttachReq.parse({
        verb: "attach",
        stream: "tell-only",
        authToken: "deadbeefdeadbeef",
        clientName: "x".repeat(65),
      })
    ).toThrow();
  });
});

describe("ClientReq — SendReq", () => {
  it("accepts ordinary text", () => {
    const out = SendReq.parse({ verb: "send", text: "hello" });
    expect(out.text).toBe("hello");
  });

  it("rejects empty text", () => {
    expect(() => SendReq.parse({ verb: "send", text: "" })).toThrow();
  });

  it("rejects text > 50_000 chars", () => {
    expect(() =>
      SendReq.parse({ verb: "send", text: "a".repeat(50_001) })
    ).toThrow();
  });
});

describe("ClientReq — StatusReq / DetachReq / PauseReq / ResumeReq", () => {
  it("StatusReq parses with just the verb", () => {
    expect(StatusReq.parse({ verb: "status" }).verb).toBe("status");
  });

  it("DetachReq parses with just the verb", () => {
    expect(DetachReq.parse({ verb: "detach" }).verb).toBe("detach");
  });

  it("PauseReq + ResumeReq parse", () => {
    expect(PauseReq.parse({ verb: "pause" }).verb).toBe("pause");
    expect(ResumeReq.parse({ verb: "resume" }).verb).toBe("resume");
  });
});

describe("ClientReq — HistoryReq", () => {
  it("accepts limit at the boundary (1 and 1000)", () => {
    expect(HistoryReq.parse({ verb: "history", limit: 1 }).limit).toBe(1);
    expect(HistoryReq.parse({ verb: "history", limit: 1000 }).limit).toBe(1000);
  });

  it("rejects limit 0 / 1001 / non-integer", () => {
    expect(() => HistoryReq.parse({ verb: "history", limit: 0 })).toThrow();
    expect(() => HistoryReq.parse({ verb: "history", limit: 1001 })).toThrow();
    expect(() => HistoryReq.parse({ verb: "history", limit: 3.14 })).toThrow();
  });
});

describe("ClientReq — ShutdownReq", () => {
  it("requires an authToken of >= 8 chars", () => {
    expect(() => ShutdownReq.parse({ verb: "shutdown" })).toThrow();
    expect(() => ShutdownReq.parse({ verb: "shutdown", authToken: "x" })).toThrow();
    const ok = ShutdownReq.parse({
      verb: "shutdown",
      authToken: "deadbeefdeadbeef",
    });
    expect(ok.verb).toBe("shutdown");
  });
});

describe("ClientReq — PointerWriteReq", () => {
  it("accepts an arbitrary string body", () => {
    const out = PointerWriteReq.parse({
      verb: "pointer-write",
      body: "## state\n\nhello",
    });
    expect(out.body).toContain("hello");
  });

  it("accepts an empty body (server decides what to do with it)", () => {
    const out = PointerWriteReq.parse({ verb: "pointer-write", body: "" });
    expect(out.body).toBe("");
  });
});

describe("ClientReq union", () => {
  it("rejects an unknown verb", () => {
    expect(() => ClientReq.parse({ verb: "evil", foo: 1 })).toThrow();
  });

  it("round-trips every well-formed verb", () => {
    const samples: ClientReq[] = [
      {
        verb: "attach",
        stream: "all",
        authToken: "deadbeefdeadbeef",
      },
      { verb: "send", text: "hi" },
      { verb: "status" },
      { verb: "history", limit: 5 },
      { verb: "detach" },
      { verb: "shutdown", authToken: "deadbeefdeadbeef" },
      { verb: "pause" },
      { verb: "resume" },
      { verb: "pointer-write", body: "x" },
    ];
    for (const s of samples) {
      const round = ClientReq.parse(JSON.parse(JSON.stringify(s)));
      expect(round.verb).toBe(s.verb);
    }
  });
});

describe("ServerResp", () => {
  it("EventResp requires lag_ms (Architect backpressure field)", () => {
    expect(() =>
      EventResp.parse({ verb: "event", type: "tell", payload: {}, ts: 0 })
    ).toThrow();
    const ok = EventResp.parse({
      verb: "event",
      type: "tell",
      payload: { text: "hi" },
      ts: 100,
      lag_ms: 5,
    });
    expect(ok.lag_ms).toBe(5);
  });

  it("round-trips every well-formed reply verb", () => {
    const samples: ServerResp[] = [
      { verb: "event", type: "tell", payload: {}, ts: 1, lag_ms: 0 },
      { verb: "status", summary: "idle", taskState: { kind: "idle" } },
      { verb: "history", entries: [{ a: 1 }] },
      { verb: "ack", of: "send" },
      { verb: "error", of: "attach", message: "auth token mismatch" },
      { verb: "pointer-write", written: true, truncated: false },
    ];
    for (const s of samples) {
      const round = ServerResp.parse(JSON.parse(JSON.stringify(s)));
      expect(round.verb).toBe(s.verb);
    }
  });
});

describe("token helpers", () => {
  it("generateToken returns 64 hex characters (32 bytes)", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ensureTokenFile creates a 0600 token file when absent", async () => {
    const tokenPath = join(workDir, "ipc-token");
    const token = await ensureTokenFile(tokenPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    if (process.platform !== "win32") {
      const st = statSync(tokenPath);
      // Mode mask 0o777 isolates permission bits.
      expect((st.mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("ensureTokenFile returns the existing token when present", async () => {
    const tokenPath = join(workDir, "ipc-token");
    const first = await ensureTokenFile(tokenPath);
    const second = await ensureTokenFile(tokenPath);
    expect(second).toBe(first);
  });

  it("readToken trims trailing whitespace from the file", async () => {
    const tokenPath = join(workDir, "ipc-token");
    writeFileSync(tokenPath, "deadbeefdeadbeef\n", { mode: 0o600 });
    const token = await readToken(tokenPath);
    expect(token).toBe("deadbeefdeadbeef");
  });
});
