#!/usr/bin/env node
/**
 * Print which GGUF variant Unsloth Studio currently has loaded.
 *
 * Studio exposes the loaded model + variant via /api/inference/status.
 * pi-mono only sees the OpenAI base id (`unsloth/<repo>-GGUF`); it has no
 * way to know whether you're hitting Q3_K_M, Q4_K_M, UD-Q4_K_XL, etc.
 * Run this when a session feels off — variant directly affects tool-call
 * schema fidelity (Q3 misses required args; Q4_K_XL is reliable).
 *
 * Override defaults via env vars:
 *   STUDIO_BASE_URL  (default: http://localhost:8888)
 *   UNSLOTH_API_KEY  (required — same key pi uses)
 */

const BASE = (process.env.STUDIO_BASE_URL || "http://localhost:8888").replace(/\/+$/, "");
const KEY = process.env.UNSLOTH_API_KEY;

if (!KEY) {
  console.error("ERR: UNSLOTH_API_KEY not set in env.");
  process.exit(2);
}

let resp;
try {
  resp = await fetch(`${BASE}/api/inference/status`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
} catch (err) {
  console.error(`ERR: connection failed: ${err.message}`);
  console.error(`     Is Studio running at ${BASE}?`);
  process.exit(2);
}

if (!resp.ok) {
  console.error(`ERR: HTTP ${resp.status} ${resp.statusText}`);
  console.error((await resp.text()).slice(0, 400));
  process.exit(2);
}

const s = await resp.json();

console.log(`active_model:  ${s.active_model ?? "(none loaded)"}`);
console.log(`gguf_variant:  ${s.gguf_variant ?? "(n/a)"}`);
console.log(`is_gguf:       ${s.is_gguf}`);
console.log(`is_vision:     ${s.is_vision}`);
console.log(`reasoning:     ${s.supports_reasoning}`);
console.log(`loaded:        ${JSON.stringify(s.loaded ?? [])}`);
console.log(`loading:       ${JSON.stringify(s.loading ?? [])}`);

if (s.gguf_variant && /^Q[23](_|$)/i.test(s.gguf_variant)) {
  console.warn(
    `\nWARN: ${s.gguf_variant} is aggressively quantized. Tool-call argument` +
      ` fidelity drops at Q2/Q3 — multi-arg tools (e.g. pi's edit) frequently` +
      ` miss required fields. Prefer Q4_K_M, UD-Q4_K_XL, or higher for agent work.`,
  );
}
