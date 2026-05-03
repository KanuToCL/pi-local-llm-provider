/**
 * scripts/pair-whatsapp.ts — standalone Baileys QR pairing flow.
 *
 * Plan refs:
 *   - §"v4.3 Phase 5 honesty disclosures" (lines 1620-1624) + §"Phase 5
 *     verification gates" (lines 1613-1618): both identity models require
 *     a documented re-pair flow when Baileys creds invalidate.  This is
 *     that flow — Sergio runs it once per identity model + once per
 *     re-pair.
 *
 * Usage (from project root):
 *
 *     # Pair with whatever WhatsApp account is on the phone you scan with.
 *     # The script writes auth state to WHATSAPP_AUTH_STATE_DIR (default
 *     # ~/.pi-comms/wa-auth/) and exits as soon as pairing completes.
 *     npx tsx scripts/pair-whatsapp.ts
 *
 *     # Override the auth directory (e.g. to keep self-chat and second-number
 *     # creds in separate folders during testing):
 *     WHATSAPP_AUTH_STATE_DIR=~/.pi-comms/wa-auth-modelB/ npx tsx scripts/pair-whatsapp.ts
 *
 * What this script does NOT do:
 *   - It does NOT validate identity-model semantics (which JID Sergio is
 *     pairing with).  That's the operator's responsibility; the script
 *     just captures whichever account scans the QR.  The daemon (IMPL-16)
 *     reads the pair-record JSON written below and cross-checks against
 *     `WHATSAPP_OWNER_JID` / `WHATSAPP_BOT_JID` at startup.
 *   - It does NOT touch any other pi-comms state (audit log, status
 *     pointer, task state).  Pairing is a transport-only setup step.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdir } from "node:fs/promises";

import qrcode from "qrcode-terminal";

import {
  loadBaileys,
  PAIR_RECORD_FILENAME,
  writePairRecord,
} from "../src/channels/whatsapp.js";

// ---------------------------------------------------------------------------
// Resolve target directory
// ---------------------------------------------------------------------------

function resolveAuthDir(): string {
  const fromEnv = process.env.WHATSAPP_AUTH_STATE_DIR;
  if (fromEnv && fromEnv.length > 0) {
    // Expand ~/ at the start; everything else is taken verbatim.
    if (fromEnv.startsWith("~/")) {
      return join(homedir(), fromEnv.slice(2));
    }
    return resolve(fromEnv);
  }
  return join(homedir(), ".pi-comms", "wa-auth");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const authDir = resolveAuthDir();

  console.log(`[pair-whatsapp] auth dir: ${authDir}`);
  console.log(
    "[pair-whatsapp] starting Baileys connection — scan the QR below " +
      "with your phone (WhatsApp → Linked Devices → Link a Device).",
  );
  console.log(
    "[pair-whatsapp] press Ctrl-C to abort if the QR expires before scan.\n",
  );

  await mkdir(authDir, { recursive: true });
  try {
    await chmod(authDir, 0o700);
  } catch {
    console.warn(
      `[pair-whatsapp] WARN: could not chmod 0700 on ${authDir} (non-Unix filesystem?). ` +
        "Make sure the directory is operator-readable only.",
    );
  }

  const baileys = await loadBaileys();
  const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);

  const sock = baileys.makeWASocket({
    auth: state,
    // We'll handle QR rendering ourselves so the output stays readable.
    printQRInTerminal: false,
    browser: ["pi-comms", "Desktop", "0.2.0"],
  });

  return new Promise<number>((resolveExit) => {
    let resolved = false;

    const finish = (code: number) => {
      if (resolved) return;
      resolved = true;
      try {
        sock.end?.(undefined);
      } catch {
        // best-effort
      }
      resolveExit(code);
    };

    sock.ev.on("creds.update", () => {
      void saveCreds().catch((error: unknown) => {
        console.error("[pair-whatsapp] saveCreds failed:", error);
      });
    });

    sock.ev.on("connection.update", (update) => {
      const u = update as {
        connection?: string;
        qr?: string;
        lastDisconnect?: { error?: { message?: string } };
      };

      if (typeof u.qr === "string" && u.qr.length > 0) {
        console.log("\n[pair-whatsapp] new QR — scan now:\n");
        qrcode.generate(u.qr, { small: true });
        console.log(
          "\n[pair-whatsapp] QR rotates every ~20s; if it expires, a new " +
            "one prints automatically.",
        );
      }

      if (u.connection === "open") {
        // Best-effort: read the paired JID off Baileys' authentication
        // state.  This is an internal-ish API but stable across 7.x.
        const stateRecord = state as {
          creds?: { me?: { id?: string } };
        };
        const jid = stateRecord.creds?.me?.id ?? "unknown@s.whatsapp.net";
        const record = {
          paired: true as const,
          jid,
          ts: Date.now(),
        };
        void writePairRecord(authDir, record)
          .then(() => {
            console.log(
              `\n[pair-whatsapp] paired successfully as ${jid}. ` +
                `Wrote ${PAIR_RECORD_FILENAME} to ${authDir}.`,
            );
            console.log(
              "[pair-whatsapp] you can now start the pi-comms daemon.",
            );
            finish(0);
          })
          .catch((error) => {
            console.error(
              "[pair-whatsapp] paired but failed to write pair record:",
              error,
            );
            finish(1);
          });
      }

      if (u.connection === "close") {
        const reason =
          u.lastDisconnect?.error?.message ?? "no error reported";
        // If we never got to "open", treat as failure; if we already
        // wrote the record, finish() already returned.
        console.error(`[pair-whatsapp] connection closed before pairing: ${reason}`);
        finish(2);
      }
    });
  });
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error("[pair-whatsapp] fatal error:", error);
    process.exit(99);
  });
