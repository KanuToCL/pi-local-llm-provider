/**
 * Tests for `src/lib/inbound-media.ts` — InboundMediaStore.
 *
 * Coverage targets (per FIX-B-4 brief, ≥3 cases + edges):
 *   1. saveAudio writes correct path + mediaType + sizeBytes.
 *   2. File is mode 0600 (best-effort on Unix).
 *   3. saveImage / saveDocument / saveVideo route to the right helper.
 *   4. ensureDir creates the directory at mode 0700.
 *   5. purgeOlderThan deletes files older than the cutoff and leaves new files.
 *   6. purgeOlderThan handles a missing directory (returns 0, no throw).
 *   7. Concurrent saves serialize through writeQueue (no torn writes).
 *   8. sanitizeMsgId hashes ids with unsafe characters; passes safe ones through.
 *   9. sanitizeExt extracts the suffix from filenames; falls back to "bin".
 *  10. Pure round-trip: saved file content matches the input buffer byte-for-byte.
 *
 * Strategy: every test uses a fresh tmpdir so saves never collide and we
 * don't pollute `~/.pi-comms`.  Mode-bit assertions are skipped on win32
 * to mirror the channel-side chmod best-effort posture.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InboundMediaStore,
  defaultInboundMediaDir,
  sanitizeExt,
  sanitizeMsgId,
} from "../src/lib/inbound-media.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-comms-inbound-media-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("InboundMediaStore — saveAudio basic round-trip", () => {
  test("writes <dir>/<msgId>.<ext> with the buffer contents and returns the ref", async () => {
    const store = new InboundMediaStore({ dir: workDir });
    const buffer = Buffer.from("OggS\x00\x02\x00\x00\x00\x00\x00\x00", "binary");
    const ref = await store.saveAudio({
      msgId: "12345",
      ext: "ogg",
      buffer,
      mimeType: "audio/ogg",
    });

    expect(ref.mediaType).toBe("audio");
    expect(ref.sizeBytes).toBe(buffer.byteLength);
    expect(ref.mimeType).toBe("audio/ogg");
    expect(ref.path).toBe(join(workDir, "12345.ogg"));

    const onDisk = readFileSync(ref.path);
    expect(onDisk.equals(buffer)).toBe(true);
  });

  test("file mode is 0600 (Unix only)", async () => {
    if (process.platform === "win32") return;
    const store = new InboundMediaStore({ dir: workDir });
    const ref = await store.saveAudio({
      msgId: "perm-check",
      ext: "ogg",
      buffer: Buffer.from([0xff, 0xee]),
    });
    const st = statSync(ref.path);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe("InboundMediaStore — image / document / video routes correctly", () => {
  test("saveImage stamps mediaType:'image' and uses .jpg suffix", async () => {
    const store = new InboundMediaStore({ dir: workDir });
    const ref = await store.saveImage({
      msgId: "img-1",
      ext: "jpg",
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(ref.mediaType).toBe("image");
    expect(ref.path.endsWith(".jpg")).toBe(true);
  });

  test("saveDocument stamps mediaType:'document' and supports filename hints", async () => {
    const store = new InboundMediaStore({ dir: workDir });
    const ref = await store.saveDocument({
      msgId: "doc-1",
      ext: "report.pdf",
      buffer: Buffer.from("%PDF-"),
    });
    expect(ref.mediaType).toBe("document");
    expect(ref.path.endsWith(".pdf")).toBe(true);
  });

  test("saveVideo stamps mediaType:'video'", async () => {
    const store = new InboundMediaStore({ dir: workDir });
    const ref = await store.saveVideo({
      msgId: "vid-1",
      ext: "mp4",
      buffer: Buffer.from([0x00, 0x00, 0x00, 0x18]),
    });
    expect(ref.mediaType).toBe("video");
    expect(ref.path.endsWith(".mp4")).toBe(true);
  });
});

describe("InboundMediaStore — ensureDir + purgeOlderThan", () => {
  test("ensureDir creates the directory at mode 0700 (Unix only)", async () => {
    const targetDir = join(workDir, "fresh-dir");
    const store = new InboundMediaStore({ dir: targetDir });
    await store.ensureDir();
    const st = statSync(targetDir);
    expect(st.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(st.mode & 0o777).toBe(0o700);
    }
  });

  test("purgeOlderThan deletes files older than the cutoff; preserves new ones", async () => {
    const store = new InboundMediaStore({ dir: workDir });

    // Save two files.  Mark one as old by tweaking mtime back ~10 days.
    const oldRef = await store.saveAudio({
      msgId: "old",
      ext: "ogg",
      buffer: Buffer.from([0x01]),
    });
    const newRef = await store.saveAudio({
      msgId: "new",
      ext: "ogg",
      buffer: Buffer.from([0x02]),
    });

    const tenDaysAgoSec = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldRef.path, tenDaysAgoSec, tenDaysAgoSec);

    const purged = await store.purgeOlderThan(7);
    expect(purged).toBe(1);

    const survivors = readdirSync(workDir);
    expect(survivors).toContain("new.ogg");
    expect(survivors).not.toContain("old.ogg");
    // The recent file is preserved on disk.
    expect(() => readFileSync(newRef.path)).not.toThrow();
  });

  test("purgeOlderThan returns 0 when the directory does not exist (no throw)", async () => {
    const store = new InboundMediaStore({
      dir: join(workDir, "never-created"),
    });
    const purged = await store.purgeOlderThan(7);
    expect(purged).toBe(0);
  });
});

describe("InboundMediaStore — concurrency", () => {
  test("concurrent saves serialize through writeQueue (final file is one of the inputs, not torn)", async () => {
    const store = new InboundMediaStore({ dir: workDir });
    // Fire 25 saves with the SAME msgId — last writer wins, but no
    // intermediate state can be torn.
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i += 1) {
      writes.push(
        store.saveAudio({
          msgId: "race",
          ext: "ogg",
          buffer: Buffer.from(`payload-${i}-${"x".repeat(64)}`),
        }),
      );
    }
    await Promise.all(writes);

    const finalPath = join(workDir, "race.ogg");
    const finalRaw = readFileSync(finalPath, "utf8");
    // The on-disk file must match one of the inputs verbatim.
    expect(finalRaw).toMatch(/^payload-\d+-x{64}$/);
  });
});

describe("InboundMediaStore — defaultInboundMediaDir", () => {
  test("returns a path under the user's home dir ending in inbound-media", () => {
    const dir = defaultInboundMediaDir();
    expect(dir.endsWith("inbound-media")).toBe(true);
    expect(dir.includes(".pi-comms")).toBe(true);
  });
});

describe("sanitizeMsgId — filesystem-safety", () => {
  test("safe alnum / underscore / dash ids pass through verbatim", () => {
    expect(sanitizeMsgId("12345")).toBe("12345");
    expect(sanitizeMsgId("abc-DEF_42")).toBe("abc-DEF_42");
  });

  test("ids with unsafe characters get hashed (no traversal possible)", () => {
    const danger = sanitizeMsgId("../../../etc/passwd");
    expect(danger).not.toContain("/");
    expect(danger).not.toContain(".");
    expect(danger.length).toBe(32);
  });

  test("leading-dot ids get hashed (no hidden dotfile creation)", () => {
    const hidden = sanitizeMsgId(".hidden");
    expect(hidden.startsWith(".")).toBe(false);
  });

  test("empty id falls back to 'empty'", () => {
    expect(sanitizeMsgId("")).toBe("empty");
  });
});

describe("sanitizeExt — extension safety", () => {
  test("plain extensions pass through lowercased", () => {
    expect(sanitizeExt("OGG")).toBe("ogg");
    expect(sanitizeExt("jpg")).toBe("jpg");
  });

  test("filename hints get the last segment", () => {
    expect(sanitizeExt("report.pdf")).toBe("pdf");
    expect(sanitizeExt("audio.message.opus")).toBe("opus");
  });

  test("non-alnum strips out, falls back to 'bin' on empty result", () => {
    expect(sanitizeExt("...")).toBe("bin");
    expect(sanitizeExt("")).toBe("bin");
    expect(sanitizeExt("!@#$%")).toBe("bin");
  });

  test("over-long extensions truncate to MAX_EXT_CHARS (8)", () => {
    expect(sanitizeExt("aReallyLongExt").length).toBeLessThanOrEqual(8);
  });
});
