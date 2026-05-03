#!/usr/bin/env node
/**
 * Validate that every env-var-name `apiKey` in ~/.pi/agent/models.json
 * resolves to a non-empty value before pi-mono is invoked.
 *
 * Why:
 *   pi-mono's `models.json` schema (≥0.70) accepts an env-var name as the
 *   `apiKey` value (e.g. `"apiKey": "UNSLOTH_API_KEY"`). Behavior when that
 *   variable is unset is not formally documented and may differ across
 *   pi-mono versions. Observed/possible outcomes:
 *     • the literal env-var name is shipped as the bearer token (R2 in
 *       docs/DESIGN.md — historically observed)
 *     • an empty string is shipped (daemon returns 401)
 *     • pi-mono raises a config error
 *   In the first case the literal name surfaces in daemon access logs,
 *   error reports, and screenshots — a credential-shaped string in
 *   places it should not be. This script makes the entire question moot
 *   by failing the launch before pi runs.
 *
 * Exit codes:
 *   0 = all referenced env vars resolve to a non-empty value
 *   1 = one or more referenced env vars are unset (listed on stderr)
 *   2 = configuration / parse / IO error
 *
 * Env overrides:
 *   PI_MODELS_JSON     path to the models.json (default: ~/.pi/agent/models.json)
 *   PI_LAUNCH_VERBOSE  if non-empty, print a one-line OK summary on success
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_PATH = resolve(homedir(), ".pi/agent/models.json");
const MODELS_PATH = process.env.PI_MODELS_JSON || DEFAULT_PATH;

let raw;
try {
  raw = readFileSync(MODELS_PATH, "utf8");
} catch (err) {
  console.error(`check-env: cannot read ${MODELS_PATH}: ${err.message}`);
  console.error(
    "           override the path with PI_MODELS_JSON if it lives elsewhere.",
  );
  process.exit(2);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch (err) {
  console.error(`check-env: ${MODELS_PATH} is not valid JSON: ${err.message}`);
  process.exit(2);
}

// File-mode hygiene check — Unix only. Mode bits 0o077 = group/other any-permission.
// pi-mono does not enforce this; the install instructions tell users to chmod 600.
if (process.platform !== "win32") {
  try {
    const mode = statSync(MODELS_PATH).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      console.warn(
        `check-env: WARN ${MODELS_PATH} mode is 0${mode.toString(8).padStart(3, "0")} ` +
          "(group/other readable).",
      );
      console.warn(`           run: chmod 600 ${MODELS_PATH}`);
    }
  } catch {
    // Non-fatal — we already read the file successfully above.
  }
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const missing = [];

for (const [provName, prov] of Object.entries(cfg.providers ?? {})) {
  const key = prov?.apiKey;
  if (typeof key !== "string" || key.length === 0) continue;

  // pi-mono treats `apiKey` as one of: env-var name (UPPER_SNAKE), shell
  // command (`!cmd ...`), or a literal token. We only validate the env-var
  // form — the other two have their own failure shapes.
  if (key.startsWith("!")) continue;
  if (!ENV_NAME_RE.test(key)) continue;

  const value = process.env[key];
  if (typeof value !== "string" || value.length === 0) {
    missing.push({ provider: provName, envVar: key });
  }
}

if (missing.length > 0) {
  console.error("check-env: pi-mono apiKey env vars unset:");
  for (const { provider, envVar } of missing) {
    console.error(`  • provider "${provider}" needs $${envVar}`);
  }
  console.error("");
  console.error(
    "If pi-mono substitutes the literal env-var name as the bearer token,",
  );
  console.error(
    "the daemon will reject auth — and the literal name will surface in",
  );
  console.error("its access logs. Set the missing variable(s) and re-run.");
  console.error("");
  console.error(
    "Bootstrap helper for the canonical key set lives in the vibration-pdm",
  );
  console.error(
    "repo at scripts/api_keys_bootstrap.py — or set the var in your shell rc.",
  );
  process.exit(1);
}

if (process.env.PI_LAUNCH_VERBOSE) {
  const provCount = Object.keys(cfg.providers ?? {}).length;
  console.error(
    `check-env: OK — ${provCount} provider(s) validated against ${MODELS_PATH}`,
  );
}

process.exit(0);
