#!/usr/bin/env node
/**
 * Pre-launch banner for pi-mono against Unsloth Studio.
 *
 * Fetches /api/inference/status + /api/models/cached-gguf and prints:
 *   - System memory total / available (from /proc/meminfo on Linux,
 *     os.totalmem/freemem fallback elsewhere)
 *   - Loaded model + variant + active vs native context
 *   - Cached GGUF variants on disk (with arrow on the loaded one)
 *   - A suggested ctx based on rough KV-cache budgeting
 *
 * Why: Studio's UI "Exceeds estimated VRAM capacity" warning anchors to
 * a 4096 fallback when the model is larger than the GPU's reported free
 * memory — meaningless on GB10's unified memory architecture, where
 * `torch.cuda.mem_get_info` reports CPU-style "free" not "available".
 * This script gives an honest picture so users don't get spooked into
 * leaving the slider at 4096 unnecessarily.
 *
 * Env overrides:
 *   STUDIO_BASE_URL  (default: http://localhost:8888)
 *   UNSLOTH_API_KEY  (required — same key pi uses)
 *   STUDIO_QUIET=1   (skip banner, exit 0; lets pi-launch.sh run silent)
 *
 * Exits 0 always (banner is informational; we never block the launch).
 */

import fs from "node:fs";
import os from "node:os";

if (process.env.STUDIO_QUIET === "1") process.exit(0);

const BASE = (process.env.STUDIO_BASE_URL || "http://localhost:8888").replace(/\/+$/, "");
const KEY = process.env.UNSLOTH_API_KEY;
const RULE = "━".repeat(63);

if (!KEY) {
  // Don't block launch — pi-launch.sh's check-env.js step handles the
  // "key actually missing" case authoritatively.  We just skip the banner.
  process.exit(0);
}

// ── memory ────────────────────────────────────────────────────────────────
function readMemory() {
  // /proc/meminfo's MemAvailable is the right number on Linux (accounts
  // for reclaimable page cache).  os.freemem() reports MemFree only, which
  // makes a freshly-loaded GGUF look like it ate all RAM.
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const totalKb = Number(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0);
    const availKb = Number(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0);
    if (totalKb && availKb) return { total: totalKb * 1024, avail: availKb * 1024, src: "/proc/meminfo" };
  } catch {}
  return { total: os.totalmem(), avail: os.freemem(), src: "os.freemem (approx)" };
}

function gib(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}
function gb(bytes) {
  return (bytes / 1e9).toFixed(1);
}

// ── KV cache rough estimator ─────────────────────────────────────────────
// Per-token bytes ≈ 2 (K+V) × n_layers × n_kv_heads × head_dim × bytes_per_elem.
// We don't have GGUF metadata client-side, so fall back to family-table
// heuristics.  These match within ~20% of llama.cpp's actual cache for the
// listed families; good enough to keep the suggestion honest without
// claiming precision.  Override by passing explicit values to the function.
const PER_TOKEN_BYTES_BY_PARAM_B = [
  // [param_count_billions_max, bytes_per_token_at_f16_kv]
  { maxB: 4, bytes: 64 * 1024 },     // 1-4B  (small dense)
  { maxB: 9, bytes: 96 * 1024 },     // 7-8B
  { maxB: 16, bytes: 160 * 1024 },   // 13-14B
  { maxB: 35, bytes: 256 * 1024 },   // 27-30B (e.g. Qwen3-27B GQA)
  { maxB: 80, bytes: 384 * 1024 },   // 70B class
  { maxB: 9999, bytes: 768 * 1024 }, // 100B+ MoE active or dense
];
function paramsBFromIdentifier(id) {
  if (!id) return null;
  // Pull "27B", "8B", "4B", "70B", "30B-A3B" etc. from the model id.
  const m = id.match(/(\d+(?:\.\d+)?)\s*B/i);
  return m ? Number(m[1]) : null;
}
function kvBytesPerToken(paramsB) {
  if (!paramsB) return 256 * 1024; // conservative default for unknown sizes
  for (const row of PER_TOKEN_BYTES_BY_PARAM_B) if (paramsB <= row.maxB) return row.bytes;
  return 768 * 1024;
}

// ── Studio fetch helpers ─────────────────────────────────────────────────
async function studioGet(path) {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ── main ─────────────────────────────────────────────────────────────────
const [status, cached] = await Promise.all([
  studioGet("/api/inference/status"),
  studioGet("/api/models/cached-gguf"),
]);

if (!status) {
  // Studio unreachable — silent skip, pi-launch.sh's check-env will catch it.
  process.exit(0);
}

const mem = readMemory();
const active = status.active_model;
const variant = status.gguf_variant;
const isGguf = status.is_gguf;
const ctxActive = status.context_length;
const ctxNative = status.native_context_length;
const ctxMaxCapped = status.max_context_length;

// Per-variant info (size on disk).  /api/models/gguf-variants is per-repo;
// for a clean banner without a second roundtrip per cached repo, list the
// repos we have cached and, if a model is loaded, fetch variants for that
// one repo only.
let variantsForLoaded = null;
if (active) {
  variantsForLoaded = await studioGet(`/api/models/gguf-variants?repo_id=${encodeURIComponent(active)}`);
}

// Suggested ctx
let suggestedCtx = null;
let kvBytesPerTok = null;
if (isGguf && ctxNative) {
  const paramsB = paramsBFromIdentifier(active);
  kvBytesPerTok = kvBytesPerToken(paramsB);
  // Budget ~50% of MemAvailable for KV (leaves headroom for model
  // working buffers, OS, and the studio process itself).
  const budgetBytes = mem.avail * 0.5;
  const ctxFromBudget = Math.floor(budgetBytes / kvBytesPerTok);
  // Cap suggestion at min(native, 32768) so we don't mislead users into
  // huge contexts that work physically but tank inference latency.
  suggestedCtx = Math.min(ctxNative, 32768, Math.max(4096, ctxFromBudget));
  // Round to nearest 1024 for prettier presentation.
  suggestedCtx = Math.round(suggestedCtx / 1024) * 1024;
}

// ── render ───────────────────────────────────────────────────────────────
const out = [];
out.push("");
out.push(RULE);
out.push(`🦥  Unsloth Studio  ·  ${BASE}`);
out.push(RULE);
out.push(`  Memory      ${gib(mem.total)} GiB total · ${gib(mem.avail)} GiB available  (${mem.src})`);
if (active) {
  out.push(`  Loaded      ${active}`);
  out.push(`  Variant     ${variant ?? "(n/a)"}${variantsForLoaded ? "" : ""}`);
  if (ctxActive != null) {
    const capNote = ctxMaxCapped && ctxMaxCapped < ctxNative ? `  ·  studio_max=${ctxMaxCapped} (UI cap)` : "";
    out.push(`  Context     ${ctxActive} active  ·  ${ctxNative} native${capNote}`);
  }
  if (suggestedCtx) {
    const kvGb = ((suggestedCtx * kvBytesPerTok) / 1024 ** 3).toFixed(1);
    out.push(`  Suggested   ctx ≈ ${suggestedCtx}   (~${kvGb} GB KV at f16; ~${kvBytesPerTok / 1024} KB/tok est.)`);
  }
} else {
  out.push(`  Loaded      (none)  ·  load via Studio UI or POST /api/inference/load`);
}

if (variantsForLoaded?.variants?.length) {
  const downloaded = variantsForLoaded.variants.filter((v) => v.downloaded);
  if (downloaded.length) {
    out.push("");
    out.push("  Cached GGUF variants on disk:");
    const w = Math.max(...downloaded.map((v) => v.quant.length));
    for (const v of downloaded) {
      const arrow = v.quant === variant ? "  ← loaded" : "";
      out.push(`    ${v.quant.padEnd(w)}   ${gb(v.size_bytes).padStart(5)} GB${arrow}`);
    }
  }
} else if (cached?.cached?.length) {
  out.push("");
  out.push("  Cached repos on disk (variant breakdown unavailable without active load):");
  for (const c of cached.cached) out.push(`    ${c.repo_id}   ${gb(c.size_bytes)} GB`);
}

if (active && ctxMaxCapped && ctxMaxCapped <= 4096 && (suggestedCtx ?? 0) > 4096) {
  out.push("");
  out.push("  Note: Studio's \"Exceeds VRAM\" UI warning is cosmetic on GB10 unified");
  out.push("        memory.  Drag the ctx slider above the 4096 fallback freely.");
}

out.push(RULE);
out.push("");

console.log(out.join("\n"));
