# INSTALL — vLLM as opt-in backend (F7)

This document covers vLLM as an **opt-in** backend variant for pi-mono.
The default backend is Unsloth Studio (Track 1 README); vLLM is a Linux+CUDA
alternative chosen for maximum throughput on production-class hardware
(GB10, H100, RTX 5090, etc.).

> **Plan reference:** `docs/plans/pi_comms_v0_3_1_telegram_polish_and_vllm_optin.plan.md` §F7.
> **Status (probe verdict):** PENDING — awaiting GB10 (gx10-831a) probe submission.
> Until a PASS verdict lands per [`CONTRIBUTING.md`](../CONTRIBUTING.md), treat
> this guide as scaffolding — the launch invocation has been validated against
> vLLM 0.6.5 docs but has not yet been exercised end-to-end against pi-mono.

---

## 1. Why vLLM as opt-in (and not the default)

The default backend (Unsloth Studio) is the right pick for almost every
single-GPU consumer setup — it has a UI, it auto-quantizes, it is
forgiving of unfamiliar tool-call configuration. vLLM is a different shape
of tool: a server-class runtime that is faster per-token at high
concurrency but assumes you already know which model you want, which
quant you want, and which tool-call parser matches your model family.

Reasons to opt-in to vLLM on a single-machine pi-comms install:

- **Production-box parity.** If pi-comms is going to run on a Linux box
  with CUDA (GB10, dedicated workstation, leased server), pinning the
  same backend across dev + prod removes a class of "works on my
  laptop" surprises.
- **Throughput at concurrency.** vLLM's continuous batching lets one
  GPU answer multiple agent loops in parallel. Studio is single-stream.
  If you intend to drive pi-comms from Telegram + WhatsApp + a
  terminal IPC client simultaneously, vLLM's tail latency is better.
- **Apache-2.0 + native HuggingFace ids.** vLLM consumes
  `huggingface/repo:branch` directly without the Studio re-pack step.

Reasons to **stay on Studio** (the default):

- You are on macOS or Windows. vLLM is Linux + CUDA only.
- You have one consumer GPU with ≤16 GB VRAM and want a UI.
- You are still picking a model. Studio's model picker is faster than
  hand-tuning vLLM CLI flags.

If neither column is decisive, **stay on Studio**. The probe verdict
matrix in [`README.md`](../README.md#probe-results) is the source of truth.

---

## 2. Pre-requisites

| Requirement | Why | Verification |
|---|---|---|
| Linux (kernel ≥ 5.15) | vLLM has no macOS/Windows builds | `uname -sr` |
| CUDA 12.1+ + matching NVIDIA driver | vLLM 0.6.5 ships against CUDA 12 wheels | `nvidia-smi` |
| Python 3.12 | `vllm==0.6.5` wheel target | `python3.12 --version` |
| ~12 GB free disk in `$HOME` | venv + `vllm`+`torch`+`flash-attn` weights | `df -h $HOME` |
| Local-loopback `:8000` free | vLLM default bind | `ss -ltn | grep :8000` (must be empty) |
| Network egress to `download.pytorch.org` + `huggingface.co` | first-time wheel + model fetch | `curl -sI https://huggingface.co` returns 200 |

This document does **not** cover Studio install (that's the README
default path) and does **not** cover GB10 unsloth setup (that's
[`docs/GB10_UNSLOTH_SETUP.md`](./GB10_UNSLOTH_SETUP.md)).

---

## 3. Install via `scripts/install-vllm.sh`

The installer is **idempotent** — running it twice is safe. It creates
a separate venv at `~/.venvs/vllm/` so vLLM's `torch` pin does not
collide with your other Python projects.

```bash
cd path/to/pi-local-llm-provider

# Dry run first — print the commands, do not execute them.
scripts/install-vllm.sh -n

# Real install.
scripts/install-vllm.sh
```

What it does (in order):

1. Refuses to run on non-Linux with a clear stderr message.
2. Detects CUDA via `nvidia-smi` (warns if missing — does not refuse,
   since CPU-only vLLM exists for tinkering, but performance will be
   unusable for anything but the smallest models).
3. Creates `~/.venvs/vllm/` (skipped if already present).
4. Installs `vllm==0.6.5` into that venv. **The version is pinned**;
   bumping it requires re-running `node scripts/probe-toolcalls.js`
   against the new build to confirm tool calls still emit OpenAI-shaped
   `tool_calls[]` (see [`README.md`](../README.md#why-the-probe)).
5. Prints a recommended `vllm serve` invocation tailored to detected
   GPU memory (e.g. `--gpu-memory-utilization 0.85` on a 24 GB card).
6. **Does NOT auto-run `vllm serve`.** You launch it yourself per §4
   below — the installer only sets up the toolchain.

To test the install without modifying anything:

```bash
scripts/install-vllm.sh -n
```

---

## 4. Launch invocation

Activate the venv and launch vLLM. The exact flags matter — pi-mono
needs structured `tool_calls[]` from the OpenAI shape, which requires
both `--enable-auto-tool-choice` AND a `--tool-call-parser` matching
your model family.

```bash
source ~/.venvs/vllm/bin/activate

vllm serve Qwen/Qwen3.6-27B-Instruct \
    --host 127.0.0.1 \
    --port 8000 \
    --enable-auto-tool-choice \
    --tool-call-parser hermes \
    --served-model-name Qwen/Qwen3.6-27B-Instruct \
    --api-key "${VLLM_API_KEY}"
```

**Flag-by-flag rationale:**

| Flag | Why |
|---|---|
| `--host 127.0.0.1` | **Loopback-only bind.** SECURITY.md R9 mitigation — without this, vLLM binds `0.0.0.0` by default and any other host on your LAN can hit `/v1/chat/completions` with no auth challenge. Always 127.0.0.1 unless you have a reason and a firewall rule. |
| `--port 8000` | vLLM default; matches `examples/models.vllm.json` baseUrl |
| `--enable-auto-tool-choice` | Activates vLLM's tool-call parser pipeline |
| `--tool-call-parser hermes` | Correct parser for Qwen3-class models. For Llama-3-class, use `llama3_json`. Wrong parser → tool calls emit as text in `delta.content` and pi-mono ignores them. See https://docs.vllm.ai/en/latest/features/tool_calling.html for the per-model-family table. |
| `--served-model-name` | Model id exposed at `/v1/models`. MUST match the `id` field in `examples/models.vllm.json`. |
| `--api-key` | Bearer token clients must present. vLLM compares this against the `Authorization: Bearer <token>` header. If you omit `--api-key`, vLLM accepts unauthenticated requests — set `authHeader: false` in models.vllm.json (it already is). If you set `--api-key`, flip `authHeader: true`. |

For non-Qwen models, use vLLM's per-model parser table. The probe
([`scripts/probe-toolcalls.js`](../scripts/probe-toolcalls.js)) is
what tells you definitively whether your parser+model combination
produces structured tool calls.

---

## 5. Probe gate

Before pointing pi-mono at vLLM, prove that tool calls work. This is
the same probe that gates every other backend in the verdict matrix.

```bash
VLLM_API_KEY="${VLLM_API_KEY}" \
PROBE_ENDPOINT=http://localhost:8000/v1 \
PROBE_MODEL=Qwen/Qwen3.6-27B-Instruct \
node scripts/probe-toolcalls.js
```

Exit 0 = ship it. Exit 1 = vLLM emitted the tool call as text (almost
always: wrong `--tool-call-parser`). Read the probe's failure mode
output — it prints the raw response body so you can see what the
backend actually returned.

If the probe passes, **submit a verdict row** per
[`CONTRIBUTING.md`](../CONTRIBUTING.md) so the README matrix can flip
from PENDING to PASS for your hardware/model.

---

## 6. models.json swap

Once the probe passes, copy the example into pi-mono's config dir:

```bash
mkdir -p ~/.pi/agent
cp examples/models.vllm.json ~/.pi/agent/models.json
chmod 600 ~/.pi/agent/models.json   # required — SECURITY.md
```

Then export the env var the file references:

```bash
export VLLM_API_KEY="<the same string you passed to vllm serve --api-key>"
```

Add the `export` line to `~/.bashrc` (or your shell rc) so pi-launch
can see it; setting it only inside the vLLM venv's activate script
will leave pi-mono with `apiKey` undefined and pi-launch will fail
closed via [`scripts/check-env.js`](../scripts/check-env.js) (R2
mitigation in `SECURITY.md`).

---

## 7. Co-existence with Unsloth Studio (GPU contention warning)

> **Do not run Studio AND vLLM with large models loaded simultaneously
> on the same GPU.** Both runtimes hold their model weights resident
> in VRAM. On unified-memory hardware (GB10, Apple Silicon emulation,
> small-RAM Linux boxes) this OOMs the entire host, not just the
> losing process — the OOM-killer can take down the X server, your
> SSH session, and pi-comms itself. Per PE Skeptic Round 1 finding I5.

If you want to flip between backends on the same GPU:

1. **Stop the inactive backend first.** Stop Studio via its tray UI;
   stop vLLM with `Ctrl+C` in the launch terminal or `pkill -f
   "vllm serve"`. Verify with `nvidia-smi` that the model has actually
   unloaded — Studio's "stop" button sometimes leaves the model
   resident for several seconds.
2. **Then start the new one.**
3. **Update `~/.pi/agent/models.json`** to point at the new provider
   block (or maintain two files and symlink the active one).
4. **Restart pi-comms.** The daemon caches the provider config at
   boot; it will not pick up a swap without a restart.

If you have multiple GPUs, vLLM's `--device cuda:N` and Studio's
device picker can coexist — but verify VRAM per-GPU with `nvidia-smi`,
do not assume.

---

## 8. Forensic pointers (when something breaks)

vLLM has its own log surface. **pi-comms cannot see it.** The
pi-comms operator log will only tell you "the LLM call returned an
error / timed out" — not why vLLM rejected the request.

When something fails, check in this order:

1. **vLLM's own stderr/stdout** in the terminal where you launched
   `vllm serve`. The most useful failure modes (OOM, model not found,
   tool-call-parser mismatch) print there.
2. **`curl http://localhost:8000/v1/models`** — confirms vLLM is up
   and serving the expected model id. If this returns 404 or a
   different id than your `models.json` says, that's the problem.
3. **`curl -H "Authorization: Bearer ${VLLM_API_KEY}"
   http://localhost:8000/v1/chat/completions -d '{...}'`** — bypasses
   pi-mono entirely. If this works, the problem is between pi-mono
   and vLLM (config or env-var mismatch). If this fails, the problem
   is vLLM itself.
4. **pi-comms operator log** at `~/.pi-comms/operator.log` — has the
   request id, but not the vLLM-side failure detail.
5. **`nvidia-smi`** — if vLLM died silently mid-request, GPU memory
   pressure is the most likely cause. See §7.

**vLLM logs are NOT in pi-comms' scope.** Do not file pi-comms issues
about vLLM-side errors — they belong in the
[vLLM project's issue tracker](https://github.com/vllm-project/vllm/issues).

---

## 9. Decision tree — vLLM vs Studio vs Ollama

```
Is your host Linux + CUDA?
│
├── No  → Studio (default, easiest) on macOS/Windows.
│         Ollama if you want the lowest-config path on macOS or Linux.
│
└── Yes → Are you driving pi-comms from multiple channels at once?
          │
          ├── No  → Studio. The UI alone is worth the small throughput hit.
          │
          └── Yes → Do you have ≥24 GB VRAM (or multi-GPU)?
                    │
                    ├── No  → Stay on Studio. vLLM on a 12 GB card with
                    │          a 27B Q4 model just OOMs differently than
                    │          Studio does.
                    │
                    └── Yes → vLLM is the right pick. Continue with §3.
```

If you ship a vLLM verdict, please open a PR adding a row to
[`README.md`](../README.md#probe-results). The matrix is the
canonical "what works" surface for new contributors picking a backend.
