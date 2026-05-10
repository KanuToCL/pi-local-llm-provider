/**
 * Sanitization helpers for prompt-injection defense and credential redaction.
 *
 * Two responsibilities (kept in one file because both run on outbound text
 * and the order matters: redact credentials BEFORE structural sanitization
 * so a credential containing angle-brackets still gets redacted by shape):
 *
 *   1. sanitizeForPromptInjection — strips angle-bracket characters and
 *      well-known prompt-section keywords so untrusted text (status pointer
 *      body, inbound user messages) cannot escape its envelope and influence
 *      the model's interpretation of system context.
 *      Per plan Pitfall #23 ("status pointer as injection vector").
 *
 *   2. redactCredentialShapes — regex-scrubs common credential patterns
 *      (AWS/GCP/Azure keys, Bearer tokens, JWT, PEM blocks, hex blobs > 32
 *      chars) and replaces each match with `[REDACTED:credential-shape]`.
 *      Per plan Pitfall RS-4 ("tell()-credential-egress"). Defense in depth:
 *      the agent SHOULD NOT exfiltrate secrets, but this catches the case
 *      where it accidentally interpolates one into a tell()/confirm() body.
 */

/** Markers commonly used to delimit prompt sections in chat-completion APIs. */
const PROMPT_SECTION_MARKERS = [
  "</previous-context>",
  "<previous-context>",
  "</user-input>",
  "<user-input>",
  "</system>",
  "<system>",
  "[SYSTEM]",
  "[/SYSTEM]",
  "IGNORE PREVIOUS",
  "IGNORE ALL PREVIOUS",
  "<|im_start|>",
  "<|im_end|>",
  "<|system|>",
  "<|user|>",
  "<|assistant|>",
];

/**
 * Strip angle-bracket characters and known prompt-section keywords.
 *
 * Strategy:
 *   - Remove every prompt-section marker (case-insensitive substring match)
 *   - Then strip remaining `<` and `>` characters
 *
 * Order matters: marker removal must precede angle-bracket stripping, or
 * a partial marker like `<system` would survive after `>` is removed.
 */
export function sanitizeForPromptInjection(text: string): string {
  if (!text) return "";

  let out = text;
  for (const marker of PROMPT_SECTION_MARKERS) {
    // Case-insensitive global removal. Escape regex metacharacters in marker.
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "");
  }

  // After markers are gone, strip raw angle brackets so callers cannot
  // construct new section markers from text that survived.
  out = out.replace(/[<>]/g, "");

  return out;
}

/** Per-pattern redaction descriptor. Order is significant: longer / more
 * specific patterns run first so they don't get partially eaten by the
 * generic hex-blob fallback at the bottom. */
const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // PEM blocks: span multiple lines including BEGIN/END markers.
  {
    name: "pem-block",
    re: /-----BEGIN [A-Z0-9 ]+ ?-----[\s\S]*?-----END [A-Z0-9 ]+ ?-----/g,
  },
  // PEM begin marker alone (in case END is missing/truncated).
  {
    name: "pem-header",
    re: /-----BEGIN [A-Z0-9 ]+ ?-----/g,
  },
  // JWTs: three base64url segments separated by dots, header starts "eyJ".
  // Require body + signature ≥ a few chars each so we don't false-match
  // ordinary "eyJ.x.y" strings.
  {
    name: "jwt",
    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  // Bearer tokens — Authorization-header style.
  {
    name: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi,
  },
  // AWS access key IDs (AKIA / ASIA prefix + 16 chars).
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  // GitHub fine-grained / classic personal access tokens.
  {
    name: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  },
  // Anthropic v2 production keys: sk-ant-api03- + body.  Listed BEFORE the
  // general sk- pattern so the more specific match wins (the redaction
  // marker is identical, but explicit naming aids forensic review).
  {
    name: "anthropic-v2",
    re: /\bsk-ant-api03-[A-Za-z0-9_\-]{20,}\b/g,
  },
  // OpenAI / Anthropic style sk-… keys (sk-proj-, sk-ant-, sk-).
  {
    name: "sk-key",
    re: /\bsk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{20,}\b/g,
  },
  // Stripe live and test secret/publishable keys.  All Stripe keys follow
  // the `<prefix>_<env>_<24-or-more chars>` shape.
  //   sk_live_, sk_test_, pk_live_, pk_test_, rk_live_, rk_test_
  {
    name: "stripe",
    re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  // Slack tokens: xox[baprs]-followed by token body (≥8 chars first segment,
  // then dash-delimited groups).  Covers bot, app, user, refresh, and
  // workspace tokens.  Anchored on `xox[baprs]-` so we don't false-match
  // arbitrary `xox` strings.
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // Twilio Account/API SIDs and API Keys.
  //   AC[a-f0-9]{32}  → AccountSid
  //   SK[a-f0-9]{32}  → API Key SID
  // The 32-hex tail is the canonical Twilio shape.
  {
    name: "twilio",
    re: /\b(?:AC|SK)[a-f0-9]{32}\b/g,
  },
  // DigitalOcean personal access tokens: dop_v1_ + 64 hex chars.
  {
    name: "digitalocean-pat",
    re: /\bdop_v1_[a-f0-9]{32,}\b/g,
  },
  // Notion integration secrets: secret_ + base64-ish body (≥32 chars).
  // Anchored on the exact prefix so we don't false-match a benign word.
  {
    name: "notion-secret",
    re: /\bsecret_[A-Za-z0-9]{32,}\b/g,
  },
  // Linear API tokens: lin_api_ + body (≥32 chars).
  {
    name: "linear-api",
    re: /\blin_api_[A-Za-z0-9]{20,}\b/g,
  },
  // Sentry DSNs: https://<32-hex-public-key>@<host>/<project-id>.
  // The DSN itself is sensitive (it's the upload credential) — redact the
  // whole URL, not just the key.
  {
    name: "sentry-dsn",
    re: /\bhttps:\/\/[a-f0-9]{32}@[A-Za-z0-9.\-]+(?::\d+)?(?:\/[A-Za-z0-9_\-/]*)?/g,
  },
  // Google API key shape: AIza + 35 url-safe chars.
  {
    name: "google-api-key",
    re: /\bAIza[A-Za-z0-9_\-]{35}\b/g,
  },
  // Generic hex blobs > 32 chars (long enough to be a key/hash, short enough
  // to skip ordinary IDs). Run LAST so specific patterns above win.
  {
    name: "long-hex",
    re: /\b[a-fA-F0-9]{33,}\b/g,
  },
];

/**
 * Replace likely credentials with a fixed redaction marker.
 *
 * The marker is intentionally identical for every pattern so callers and
 * downstream readers cannot infer what kind of secret leaked from the
 * shape of the redaction.
 */
export function redactCredentialShapes(text: string): string {
  if (!text) return "";

  let out = text;
  for (const { re } of CREDENTIAL_PATTERNS) {
    out = out.replace(re, "[REDACTED:credential-shape]");
  }
  return out;
}

/**
 * Telegram bot token shape: `bot<8-12 digit id>:<≥30 url-safe-char secret>`.
 *
 * Per Ring of Elders v0.3 Round 1 Security Elder finding B1: grammY's
 * `HttpError` messages can include the request URL with the embedded token
 * (e.g. `https://api.telegram.org/bot<id>:<secret>/getUpdates failed`),
 * which would leak via the operator log to disk if the channel/daemon
 * surfaces the error verbatim.
 *
 * We replace ONLY the `<id>:<secret>` body and keep the literal `bot`
 * prefix so error URLs stay human-parseable as
 * `https://api.telegram.org/bot[REDACTED]/getUpdates`.
 *
 * Defense-in-depth helper. Integration into the channel error-log call
 * sites is tracked separately (FIX-W2-A; IMPL-W1-G1's restart() uses an
 * inline temporary).
 */
const TELEGRAM_BOT_TOKEN_SHAPE = /bot\d{8,12}:[A-Za-z0-9_-]{30,}/g;

export function redactBotToken(s: string): string {
  if (!s) return "";
  return s.replace(TELEGRAM_BOT_TOKEN_SHAPE, "bot[REDACTED]");
}

// ----- v0.3.1 F1: defensive false-success-prefix strip -----
//
// Per gx10-831a MIB-2026-05-09-2305 §1 + Ring of Elders v0.3.1 Round 2.

/**
 * Strip model-emitted false-success markers from REPLY text BEFORE chunking.
 *
 * Per MIB-2026-05-09-2305 §1: the local Qwen3.6 over-generalizes from its
 * own conversation history (where the daemon's task_completed formatter
 * historically rendered "pi: ✅ done. ...") and emits the marker as a prefix
 * on plain reply turns — including ones that say "the sandbox is having
 * issues right now". This is a UX disaster on Telegram.
 *
 * Plan v0.3.1 has TWO mitigations:
 *   1. Drop the "pi: ✅ done. " prefix from formatChannelEvent's
 *      task_completed rendering (kills the pattern in the model's input
 *      history at source).
 *   2. This defensive strip — applied in formatChannelEvent for "reply"
 *      AND "task_completed" events (NB-2 mutation-path defense; see
 *      src/session.ts:1659-1668) — catches residual emissions while the
 *      model's training-history influence fades.
 *
 * Anchored at start (with optional leading whitespace AND optional "pi:"
 * prefix per Adversarial NB-3 — model can emit "  pi: ✅ done." or
 * "\npi: ✅ done." with leading whitespace). Capped at 10 iterations to
 * bound worst-case ReDoS surface. Mid-text occurrences are NEVER stripped
 * (the model legitimately uses ✅ as inline content).
 *
 * Empty-result handling (Adversarial NB-4): if the strip leaves an empty
 * string (e.g., model emitted literal "pi: ✅ done." with no content),
 * return a fallback "pi: ok" instead. Otherwise telegram.ts:518's
 * `if (!text) return` short-circuit silently drops the message — worse
 * UX than the bug being fixed.
 */
// Plan v3 §1.1a regex spec was `/^\s*(?:pi:\s*)?(?:\s*✅\s*done\.?\s*\n?){1,10}/i`
// but its `pi:` group sat OUTSIDE the {1,10} quantifier — it could only match
// the prefix at iteration #1, not on stacked occurrences. The plan §1.1e
// fixture `"pi: ✅ done.\npi: ✅ done. Let me try..."` → `"Let me try..."`
// REQUIRES the `pi:` to repeat inside the iteration. Moved into the inner
// group; same anchor + same {1,10} ReDoS cap; semantics match the plan's
// stated intent (the fixture is the spec, the literal regex was a bug).
const FALSE_SUCCESS_PREFIX_RE =
  /^\s*(?:(?:pi:\s*)?\s*✅\s*done\.?\s*\n?){1,10}/i;

export function stripFalseSuccessPrefix(text: string): string {
  const stripped = text.replace(FALSE_SUCCESS_PREFIX_RE, "");
  // NB-4: if the original text was non-empty but the strip emptied it,
  // return a fallback so the channel's empty-text guard doesn't silently
  // drop the message.
  if (text.length > 0 && stripped.length === 0) {
    return "pi: ok";
  }
  return stripped;
}
