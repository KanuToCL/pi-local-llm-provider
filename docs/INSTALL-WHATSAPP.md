# INSTALL-WHATSAPP

Operator guide for setting up the WhatsApp channel of `pi-comms` on top of
[Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys@^7`).

## Threat-model honesty (READ FIRST)

WhatsApp does not offer a public bot API for personal accounts. Baileys is
a **reverse-engineered WhatsApp Web client**. That has consequences:

- **Account-ban risk.** Meta can (and occasionally does) ban accounts that
  use unofficial clients. Probability is not zero. **Choose your model
  with that in mind.**
- **Re-pair risk.** Baileys credentials can invalidate at any time
  (WhatsApp version drift on Meta's side, multi-device protocol
  changes, phone replacement, OS reinstall). When this happens the
  daemon goes silent until you re-run `scripts/pair-whatsapp.ts`. This
  is documented in plan §"v4.3 Phase 5 honesty disclosures" + Pitfall #1.
- **Identity surface.** Baileys connects "as" whichever WhatsApp account
  scanned the QR. Every message pi sends comes from THAT account — not
  from a separate bot identity. This is the load-bearing constraint
  driving the two identity-model choice below.

Two identity models are supported, selectable at runtime via the
`WHATSAPP_IDENTITY_MODEL` env var. Both ship as production-quality
configurations (per plan §"v4.3 Phase 5 — must support both identity
models"). **Pick one and commit before pairing — switching models requires
a fresh pair flow + daemon restart.**

---

## Model B — second number for pi (RECOMMENDED)

Sergio's primary recommendation. Pi pairs with a separate, cheap
secondary WhatsApp account; you DM it from your main number; pi replies
as the bot account.

**Why this is the recommended default:**
- Account-ban risk lands on the bot account, not your social graph.
  Losing pi's account means re-pairing pi; it does NOT mean losing
  your contacts, group chats, business presence, or media history.
- Conversation hygiene: pi's chat appears as a normal contact thread
  alongside your other contacts. Easy to mute, archive, or delete.
- No "Self" thread pollution.

**Tradeoff:** You need a phone number that can receive a single SMS
verification. Cheap options:
- [Google Voice](https://voice.google.com) — US only, free, instant.
- A pay-as-you-go eSIM (Airalo, Holafly, Truphone) — works
  internationally, ~US$5.
- A cheap prepaid SIM in a spare phone — works anywhere, requires a
  spare device for the initial WhatsApp install.

### Setup steps (Model B)

1. **Acquire the second number** (see options above).
2. **Install WhatsApp on a device with that number.**  Verify the SMS
   code; complete WhatsApp's onboarding (skip the "tell us your
   contacts" step if you want pi's account fully isolated).
3. **Pick the account name + photo** — this is what your main account
   will see when pi messages you. Suggestions: "pi" with a small
   robot/lambda icon. Honesty: this account is operated by an LLM;
   don't impersonate a human.
4. **Configure pi-comms.** In your `.env`:
   ```bash
   WHATSAPP_IDENTITY_MODEL=second-number
   WHATSAPP_OWNER_JID=15105551234@s.whatsapp.net    # your MAIN number
   WHATSAPP_BOT_JID=15106666666@s.whatsapp.net      # your bot's number
   ```
   The JID format is `<E.164-no-plus>@s.whatsapp.net`.
5. **Pair Baileys with the BOT account.**  On the device running
   pi-comms:
   ```bash
   cd ~/Desktop/Cosas/personal/pi-local-llm-provider
   npx tsx scripts/pair-whatsapp.ts
   ```
   A QR code prints. **Open WhatsApp on the BOT-account phone**, go to
   Settings → Linked Devices → Link a Device, scan the QR. Once paired,
   the script writes `pi-comms-pair.json` to `~/.pi-comms/wa-auth/` and
   exits.
6. **From your main account, send the bot a "ping" message.**  This
   establishes the chat thread; pi's first inbound goes through the
   normal classifier + sandbox path.
7. **Start the daemon.** It picks up the auth state from
   `~/.pi-comms/wa-auth/` and replies as the bot account.

---

## Model A — self-chat with your own number

Use this only if Model B's second-number requirement is a hard blocker.
Baileys pairs with YOUR primary WhatsApp account. You send messages to
yourself in WhatsApp's "Self" thread; pi sees them as inbound and
replies into the same thread.

**Risks specific to Model A:**
- **pi shares your WhatsApp identity.** If a destructive prompt-injection
  RCE makes it past the classifier and pi auto-replies during a compromise,
  recipients see those messages as YOU. The blast radius is your social
  graph.
- **Your "Self" thread becomes a mixed pi-and-personal-notes log.** Can
  be confusing during search; can be embarrassing if someone glances at
  your phone.
- **Account-ban risk lands on your primary account.** Losing it loses
  all your contacts.

### Setup steps (Model A)

1. **Configure pi-comms.** In your `.env`:
   ```bash
   WHATSAPP_IDENTITY_MODEL=self-chat
   WHATSAPP_OWNER_JID=15105551234@s.whatsapp.net    # your number
   # WHATSAPP_BOT_JID is unused in self-chat mode
   ```
2. **Pair Baileys with your primary account:**
   ```bash
   cd ~/Desktop/Cosas/personal/pi-local-llm-provider
   npx tsx scripts/pair-whatsapp.ts
   ```
   Scan the QR with the phone where your primary WhatsApp number lives
   (Settings → Linked Devices → Link a Device).
3. **Open the "Self" thread** in WhatsApp (your own contact at the top
   of the chat list, sometimes labeled "Message yourself"). Send pi a
   greeting; pi replies into the same thread.
4. **Start the daemon.**

---

## Re-pair flow (when Baileys creds invalidate)

Symptoms:
- The daemon stops sending messages despite being healthy locally
  (`pi-comms status` shows `whatsapp: degraded` or
  `whatsapp_reauth_needed`).
- Audit log shows `whatsapp_reauth_needed` events.
- Your phone's Linked Devices screen shows pi-comms as "Disconnected".

What happened: WhatsApp invalidated the linked-device session. Common
triggers:
- WhatsApp's mobile app updated and the new version dropped your
  multi-device session.
- You logged out of WhatsApp on the phone (full logout, not app-close).
- Multi-device protocol drift on Meta's side (uncommon but possible).

**Re-pair procedure (same for both models):**

1. **Stop the daemon.** `pi-comms shutdown` or kill the process.
2. **Wipe the auth state.** Removing the directory forces a clean pair:
   ```bash
   rm -rf ~/.pi-comms/wa-auth/
   ```
   The `pi-comms-pair.json` and audit log + status pointer are NOT
   under `wa-auth/`; they survive the wipe.
3. **Re-run the pair script:**
   ```bash
   npx tsx scripts/pair-whatsapp.ts
   ```
4. **Scan the QR with the SAME account you originally paired with.**
   For Model B that's the bot phone; for Model A that's your primary
   phone.
5. **Restart the daemon.** It picks up the fresh auth state and the
   `whatsapp_connect` audit event fires.

If you re-pair with the WRONG account, the daemon will refuse to start
(per the daemon's startup check that compares the pair-record JID
against `WHATSAPP_OWNER_JID` / `WHATSAPP_BOT_JID`).

---

## Reconnect behavior (V5-C reason-code branching)

Per plan §"V5-C promoted to Phase 5 implementation requirement", the
channel's reconnect logic branches on Baileys' `DisconnectReason`:

| Reason code | Behavior |
|---|---|
| `loggedOut` (401) | No auto-reconnect. Emits `whatsapp_reauth_needed` audit. Channel enters terminal-degraded state until you re-run `pair-whatsapp.ts`. |
| `restartRequired` (515) | One immediate retry. If that also fails, falls into the generic backoff path. |
| `connectionLost` / `connectionClosed` / `timedOut` / `badSession` / others | Exponential backoff: 60s → 120s → 240s → 480s → 960s, capped at 30min. ±20% jitter on each interval. After 10 consecutive failures the channel enters terminal-degraded state. |

In a terminal-degraded state the daemon is alive (it still serves
terminal CLI requests, status pointer reads, etc.) but WhatsApp is
silent until manual intervention. The dead-man-switch script
(IMPL-19's territory) escalates this via push notification.

---

## Known limitations

- **Voice messages are NOT decoded in v1.** Pi receives a placeholder
  message ("[user sent a voice — voice support is deferred to v2;
  please type]") and routes that text through the agent. The audio file
  itself is NOT downloaded. This is per Pitfall #21; the v2 path
  (whisper.cpp) is the planned upgrade.
- **Image and document inbound are similarly stubbed.** Same rationale:
  v1 doesn't want the security surface of media downloads.
- **Group chats are silently dropped.** The DM-only allowlist filter
  rejects any message with a `@g.us` remote JID; this is logged as a
  `dm_only_reject` audit event but pi never replies. v1 is single-user
  DM-only; multi-user group support is v3+.
- **No read receipts or typing indicators.** Both are technically
  possible via Baileys but emit observable presence; v1 keeps the
  surface minimal.
- **No message reactions.** Same rationale.
- **No outbound chunk-rate-limiting beyond `chunkSize`.** WhatsApp
  rate-limits aggressive sending; the daemon's tool-discipline (one
  `tell()` per task, summary-only) keeps us well under any reasonable
  threshold. If you ever hit rate limits, lower `chunkSize` or add a
  per-message sleep in `WhatsappChannel.send`.
- **Account ban: irreversible from our side.** If Meta bans the bot
  account, you must acquire a new number and re-pair. There is no
  pi-comms-side mitigation — by design we do nothing that signals
  "automated" beyond what Baileys itself does.

---

## Sanity checks before going live

- `pi-comms status` reports `whatsapp: connected` (or omits whatsapp
  entirely if `WHATSAPP_IDENTITY_MODEL` is unset).
- A test message from your owner-JID round-trips: you DM the bot,
  pi replies with the system-prompt-driven greeting.
- A non-allowlisted JID (test from a friend's phone if you have access,
  or from a different account) gets NO reply and NO ack — silent
  rejection plus an `allowlist_reject` audit entry.
- A group message (add the bot to a test group, send a message)
  gets NO reply — silent rejection plus a `dm_only_reject` audit entry.
- Audit log under `~/.pi-comms/audit.YYYY-MM-DD.jsonl` shows
  `whatsapp_connect` + the inbound/outbound entries (sender JIDs are
  hashed; raw JIDs never hit disk).

If any of those fail, check the operator log
(`OPERATOR_LOG_LEVEL=debug` for full detail) and consult
[plan §"Pitfalls catalog"](plans/pi_comms_daemon.plan.md) before
filing an issue.
