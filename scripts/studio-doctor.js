#!/usr/bin/env node
/**
 * studio-doctor — read-only Unsloth Studio multiplicity scanner.
 *
 * Per gx10-831a MIB-2026-05-09-1126 §1 (dup-Studio silent spawn) +
 * Ring of Elders v0.3.1 Round 1 (loopback-only invariant, content
 * sanitization, parallel scans).
 *
 * Exit 0 always (informational). NO port killing, NO Studio mutation,
 * NO auto-baseUrl-rewrite.
 *
 * Usage:
 *   node scripts/studio-doctor.js
 *   STUDIO_DOCTOR_PORT_RANGE=8888-8898 node scripts/studio-doctor.js
 */

// Hardcoded loopback (R35 invariant). NOT configurable.
const HOST = "127.0.0.1";
const TIMEOUT_MS = 500;
const MAX_PORT_SPAN = 100;

// Strict input validation (per Ring of Elders Round 1 PE I3 + Adversarial #6).
function parseRange(env) {
  const raw = env ?? "8888-8908";
  const parts = raw.split("-");
  if (parts.length !== 2) {
    console.error(`studio-doctor: STUDIO_DOCTOR_PORT_RANGE must be 'start-end' (got: '${raw}')`);
    process.exit(2);
  }
  const [start, end] = parts.map(Number);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    console.error(`studio-doctor: STUDIO_DOCTOR_PORT_RANGE must be integers (got: '${raw}')`);
    process.exit(2);
  }
  if (start <= 0 || end > 65535 || end < start) {
    console.error(`studio-doctor: invalid range ${start}-${end}`);
    process.exit(2);
  }
  if (end - start > MAX_PORT_SPAN) {
    console.error(`studio-doctor: range too wide (${end - start} > ${MAX_PORT_SPAN})`);
    process.exit(2);
  }
  return [start, end];
}

const [START, END] = parseRange(process.env.STUDIO_DOCTOR_PORT_RANGE);

// Content sanitization (Security W2): truncate + ASCII-printable only.
function sanitize(s) {
  if (typeof s !== "string") return "(non-string)";
  return s.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
}

// Parallel scans via Promise.allSettled (PE I6).
async function probe(port) {
  try {
    const resp = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) return { port, status: "non-ok", code: resp.status };
    const data = await resp.json().catch(() => null);
    if (!data) return { port, status: "non-json" };
    return {
      port,
      status: "healthy",
      studio_root_id: sanitize(data.studio_root_id ?? ""),
      loaded: sanitize(data.loaded ?? ""),
    };
  } catch (e) {
    return null; // not responding
  }
}

const ports = [];
for (let p = START; p <= END; p++) ports.push(p);
const results = (await Promise.allSettled(ports.map(probe)))
  .map((r) => (r.status === "fulfilled" ? r.value : null))
  .filter(Boolean);

// Output
if (process.env.STUDIO_QUIET === "1") process.exit(0);

const sep = "━".repeat(67);
console.log(sep);
console.log(`studio-doctor — scanning ${HOST}:${START}-${END}`);
console.log(sep);
if (results.length === 0) {
  console.log("  no Studio responded.");
} else {
  for (const r of results) {
    const tag = r.status === "healthy"
      ? `studio_root_id=${r.studio_root_id.slice(0, 8)}…  loaded=${r.loaded}`
      : `${r.status}${r.code ? ` (HTTP ${r.code})` : ""}`;
    console.log(`  :${r.port}  ${tag}`);
  }
}
console.log(sep);
if (results.length > 1) {
  console.log("⚠  More than one Studio responded.  pi-mono routes to whichever");
  console.log("    `baseUrl` in ~/.pi/agent/models.json resolves to.");
}
console.log(sep);

// Structured operator-log line (Observability I-O3).
console.error(JSON.stringify({
  event: "studio_doctor_observed",
  studio_count: results.length,
  ports_responding: results.map((r) => r.port).join(","),
}));

process.exit(0);
