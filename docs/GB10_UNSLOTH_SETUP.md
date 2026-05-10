# GB10 + Unsloth + pi-local — Setup Runbook

> **Goal**: get the ASUS GB10 (Project Digits / DGX Spark, 128 GB unified memory, ARM64 + Blackwell GPU) running Unsloth fine-tuning AND serving an OpenAI-compatible HTTP endpoint that pi-local-llm-provider can talk to.
>
> **Audience**: Sergio. Phone-readable. Copy-paste commands. "Why" notes only where the choice is non-obvious.
>
> **Time estimate**: 2-4 hours wall-time on first run (driver install + the inevitable ARM64 wheel dance). 30 min on subsequent boxes.

---

## What you're building

```
┌─────────────────────────────────────────────────────────┐
│  GB10 (ARM64 + Blackwell, 128 GB unified)               │
│                                                         │
│  ┌──────────────────┐    ┌────────────────────────┐    │
│  │ Unsloth training │    │ Inference server        │    │
│  │ (LoRA / QLoRA /  │ ─► │ (Studio, llama-server,  │    │
│  │  full fine-tune) │    │  or vLLM — pick one)    │    │
│  └──────────────────┘    └──────────┬─────────────┘    │
│                                     │                   │
└─────────────────────────────────────┼───────────────────┘
                                      │ /v1/chat/completions
                                      ▼ (HTTP, port :8888 or :8080)
                          ┌─────────────────────────┐
                          │ pi-local-llm-provider   │
                          │ (TS daemon, runs on     │
                          │  any box on LAN)        │
                          └────────────┬────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────┐
                          │ Telegram / WhatsApp     │
                          │ (your phone)            │
                          └─────────────────────────┘
```

Two roles per GB10: **training** (Unsloth) and **serving** (Studio or llama-server). They're independent — you can stop the server during training and vice versa.

---

## Step 1 — OS

Two clean choices for GB10's ARM64 platform:

| OS | Why pick it | Why skip |
|---|---|---|
| **DGX OS** (NVIDIA's curated Ubuntu) | CUDA + drivers pre-installed, "it just works" | Opinionated, harder to customize, slower upstream Ubuntu kernels |
| **Ubuntu 24.04 LTS ARM64** | Vanilla, latest packages, full control | Have to install CUDA + drivers yourself |

**Recommendation**: start with DGX OS (the box ships with it preloaded). Re-flash to Ubuntu only if DGX OS gets in your way.

Verify after first boot:
```bash
uname -m              # expect: aarch64
nvidia-smi            # expect: Blackwell GPU listed, driver version ≥ 555
nvcc --version        # expect: CUDA 12.4+ (12.8 ideal for Blackwell)
```

If `nvidia-smi` works, you're 80% of the way there.

---

## Step 1.5 — SSH access from your other boxes (do this early)

Set this up RIGHT after Step 1 so you can drive the remaining steps remotely from your Windows 5070 box (or your Mac). Once SSH works, the GB10 can sit headless in another room and you control it from your usual desk — and Claude Code on Windows can reach across via the Bash tool.

### On the GB10

```bash
sudo apt install -y openssh-server tmux
sudo systemctl enable --now ssh

# Note your LAN IP — you'll need it from the other box
ip addr show | grep "inet " | grep -v 127.0.0.1
```

**Recommended**: log into your router and assign GB10 a **static DHCP lease** by MAC address so the LAN IP doesn't drift. Saves headaches when you reboot.

### On Windows (your 5070 box)

Windows 10/11 ships OpenSSH client built in — no install needed.

```powershell
# Generate a key (skip if you already have one at ~\.ssh\id_ed25519)
ssh-keygen -t ed25519 -C "sergio@5070"

# Copy public key to GB10 (Windows OpenSSH lacks ssh-copy-id, do it manually)
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh sergio@<gb10-lan-ip> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# Test
ssh sergio@<gb10-lan-ip>
```

### Save an alias so you don't memorize the IP

Edit (or create) `$env:USERPROFILE\.ssh\config` on Windows (or `~/.ssh/config` on Mac/Linux):

```ssh-config
Host gb10
  HostName 192.168.X.Y          # your GB10 LAN IP
  User sergio
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 60
  ServerAliveCountMax 3
  # ControlMaster speeds up Claude's ssh-per-command pattern from ~500ms → ~10ms
  ControlMaster auto
  ControlPath ~/.ssh/cm_%r@%h:%p
  ControlPersist 10m
```

After this, just `ssh gb10` from anywhere on Windows. Test it.

### Make Claude Code reach across cleanly

Once `ssh gb10` works passwordlessly with key auth, Claude Code's Bash tool can drive the GB10 from your Windows session:

```bash
# Quick checks from a Windows-Claude session
ssh gb10 "nvidia-smi"
ssh gb10 "ls -la ~/projects"

# Long-running jobs — use tmux on GB10 so they survive SSH disconnects
ssh gb10 "tmux new-session -d -s training 'python train.py'"
ssh gb10 "tmux capture-pane -t training -p | tail -40"   # peek at output
ssh gb10 "tmux send-keys -t training 'C-c' Enter"        # stop it remotely

# Server processes — same tmux pattern
ssh gb10 "tmux new-session -d -s vllm 'vllm serve Qwen/Qwen3.6-35B-A3B --port 8000 ...'"
```

The ControlMaster line in `~/.ssh/config` is the speed multiplier — without it, every `ssh gb10 "..."` call re-handshakes (~500ms latency). With it, the first call opens a master connection that subsequent calls reuse (~10ms per call). Big quality-of-life win when Claude is firing many small commands.

### The actually-better pattern for major work: Claude Code ON the GB10

For deep work sessions (training runs, RAG pipeline edits, multi-file refactors), install Claude Code directly on the GB10 (Linux ARM64 binary works) and SSH in to use it. Local file system access, GPU access, low-latency tooling — much better experience than driving across boxes.

**Two-environment pattern that works**:
- **Windows-Claude**: orchestration · planning · cross-box coordination · quick remote checks via `ssh gb10 "..."`
- **GB10-Claude**: heavy work directly on the GPU box · training · model serving config · RAG v2 pipeline edits

Both write to the same git repo (clone on both boxes; sync via `git pull` / `git push` between sessions). Same MIB protocol used cross-machine elsewhere in the project.

### Optional sweetener — Tailscale

If your LAN ever gets weird (router resets, IP shuffles, you want to ssh from outside your network), install [Tailscale](https://tailscale.com) on both Windows and GB10. Free for personal use. You get a stable hostname (`gb10.tail-net.ts.net`) that works from anywhere, WireGuard encryption end-to-end, no port forwarding. ~5 min setup. Skip until you actually hit a LAN problem.

### Quick sanity check before moving on

From Windows PowerShell:
```powershell
ssh gb10 "uname -m && nvidia-smi --query-gpu=name --format=csv,noheader"
# Expect: aarch64 + Blackwell GPU name
```

If both show, you're done with this step. The rest of the runbook (Steps 2-7) can be driven remotely.

---

## Step 2 — Python env

Use a venv per project. Don't pollute system Python.

```bash
sudo apt update
sudo apt install -y python3.12 python3.12-venv python3.12-dev build-essential git curl

# Create the env in your project dir
cd ~/projects/gb10-unsloth        # or wherever
python3.12 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip wheel setuptools
```

**Why 3.12**: Unsloth + PyTorch + bitsandbytes all support 3.12; older 3.10/3.11 work too but 3.12 is forward-friendly.

---

## Step 3 — PyTorch with CUDA-arm64

NVIDIA publishes ARM64 CUDA wheels via their `sbsa` channel. Use the official PyTorch index:

```bash
# CUDA 12.8 (matches Blackwell)
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
```

Verify:
```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# expect: True, NVIDIA GB10 (or similar Blackwell name)
```

If `False`, the driver version is older than the CUDA wheels expect. Fix: `sudo apt install nvidia-driver-555` (or newer) + reboot.

---

## Step 4 — Unsloth

```bash
pip install unsloth
```

If you see ImportErrors complaining about `bitsandbytes` or `flash-attn`, install them explicitly:

```bash
# bitsandbytes — the historical ARM64 pain point. As of 2025 the official
# wheel works; if it doesn't, force a source build:
pip install bitsandbytes
# OR if that gives an error:
pip install bitsandbytes --no-binary :all:

# flash-attn — speeds up attention significantly. Source build takes ~30 min
# on Grace; do it once per Python version:
MAX_JOBS=4 pip install flash-attn --no-build-isolation
```

Smoke test:
```python
# save as smoke_unsloth.py
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen2.5-7B-bnb-4bit",
    max_seq_length=2048,
    load_in_4bit=True,
)
print("✅ Unsloth + CUDA + 4-bit quant all working")
```

```bash
python smoke_unsloth.py
```

If it loads without crashing, your training stack is ready.

---

## Step 5 — Pick + run an inference server

Choose ONE based on your priority:

### Option A — Unsloth Studio (recommended for daily use)

Studio loads GGUF models and exposes an OpenAI-compat `/v1` server. **On Linux/aarch64 it ships as a Python package** — no AppImage exists despite older docs (and Unsloth's web copy at the time of writing) implying otherwise. Empirically validated on GB10 / Ubuntu aarch64 / Python 3.12 (see `docs/MIB-2026-05-08-2256.md`).

```bash
# Reuse the venv from Step 4 (where unsloth itself is already installed)
~/.venvs/unsloth/bin/pip install --upgrade pip
~/.venvs/unsloth/bin/pip install unsloth-studio

# torchvision wheel must match torch's +cuXXX tag — explicit upgrade
# (without this, pip pulls a CPU-only or stale aarch64 build that breaks Studio)
~/.venvs/unsloth/bin/pip install --index-url \
  https://download.pytorch.org/whl/cu128 'torchvision>=0.26.0'

# Studio backend deps (NOT pulled by unsloth-studio's setup.py — known upstream gap)
~/.venvs/unsloth/bin/pip install -r \
  ~/.venvs/unsloth/lib/python3.12/site-packages/studio/backend/requirements/studio.txt
~/.venvs/unsloth/bin/pip install python-multipart  # referenced via runtime check, not in studio.txt

# Launch — bootstrap admin password is printed ONCE on first run; SAVE IT
~/.venvs/unsloth/bin/unsloth studio -p 8888
```

Verify the server is up:
```bash
curl http://127.0.0.1:8888/api/health
```

**API key for pi-mono:** the bootstrap admin password is for the Studio web UI ONLY (`http://localhost:8888`). For pi-mono and probe scripts you need an `sk-unsloth-<32 hex>` token, minted in either:
- Studio UI → **Settings → API keys → Create**
- OR via `POST /api/auth/login` (with admin user + bootstrap password) to get a JWT, then `POST /api/auth/api-keys` to mint the bearer token

Export it in your **shell rc** (NOT in `venv/bin/activate` — pi-mono inherits the user's shell env, not venv state, and will see `apiKey` as undefined):
```bash
echo 'export UNSLOTH_API_KEY=sk-unsloth-...' >> ~/.bashrc   # or ~/.zshrc
```

Then in the Studio UI: load your model (e.g., `unsloth/Qwen3.6-27B-GGUF`, BF16 if you have the RAM, otherwise UD-Q4_K_XL or Q5/Q8). Studio auto-exposes the loaded model on `/v1`.

Verify the OpenAI-compat surface (this is the contract pi-mono uses):
```bash
curl -H "Authorization: Bearer $UNSLOTH_API_KEY" http://localhost:8888/v1/models
curl -X POST http://localhost:8888/v1/chat/completions \
  -H "Authorization: Bearer $UNSLOTH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"unsloth/Qwen3.6-27B-GGUF","messages":[{"role":"user","content":"Hello"}]}'
```

### 5B — Known quirks (Studio on GB10 unified memory)

Per gx10-831a MIB-2026-05-09-0103 §3 (empirically verified on GB10 / Ubuntu
aarch64 / 128 GB unified pool).

#### Studio's "Exceeds estimated VRAM" warning is cosmetic on GB10

When the chat-settings slider goes above 4096, the UI may flash:
  "Exceeds estimated VRAM capacity (4,096 tokens). The model may use
   system RAM."

Ignore it. The estimator anchors to `torch.cuda.mem_get_info`'s "free"
field, which on Grace-Blackwell unified memory reflects a moment-in-time
CPU-RAM-style measurement that excludes reclaimable page cache. Right
after loading a 50+ GB BF16 GGUF, "free" can drop near zero even though
100+ GB of unified pool is still available. KV cache for a 32k context
on a 27B-class GQA model is ~8 GB — well within real headroom. Drag the
slider to 32768 (or higher) freely.

If you want the suggestion auto-derived from real available memory,
`scripts/pi-launch.sh` prints a banner with `MemAvailable`, the loaded
variant, and a recommended ctx before exec'ing pi (skip with
`STUDIO_QUIET=1`). The banner uses real-Linux `MemAvailable` (not the
`MemFree` field that lies about page-cache reclaimability), reads the
loaded model + variant from `/api/inference/status`, lists cached GGUF
variants on disk with the active one marked, and prints a per-token
KV-cache estimate keyed off the parsed `<param>B` model size.

**Implementation note for the curious.** The warning fires from
`studio/backend/core/inference/llama_cpp.py:_fit_context_to_vram`
(budgets `0.90 × free_VRAM` for KV cache) → `_get_gpu_free_memory`
(line 807, calls `torch.cuda.mem_get_info`) → fallback ceiling at line
2013 (`max_available_ctx = min(4096, native_ctx_for_cap)`) →
`chat-settings-sheet.tsx:723` renders the warning whenever the slider
exceeds that 4096 cap. Empirical proof the path is salvageable: loading
UD-Q8_K_XL (35 GB) when free was higher gave `max_available_ctx =
221440` automatically — same code path, useful number when its inputs
reflected reality. The fix belongs upstream in `unsloth-studio` (a
hardware-aware unified-memory branch), not patched from this side.

### Option B — llama-server (lean, headless, scriptable)

If you don't want a GUI:

```bash
# Build llama.cpp with CUDA support
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DGGML_CUDA=ON
cmake --build build --config Release -j

# Download a GGUF model (example: Qwen3.6-27B UD-Q4_K_XL)
# (use huggingface-cli or wget — model URLs on the Unsloth HF org page)

# Serve with OpenAI-compatible API + tool calling
./build/bin/llama-server \
  --model /path/to/Qwen3.6-27B-UD-Q4_K_XL.gguf \
  --host 0.0.0.0 \
  --port 8080 \
  --n-gpu-layers 99 \
  --jinja \
  --chat-template qwen \
  --ctx-size 32768
```

Verify:
```bash
curl http://localhost:8080/v1/models
```

### Option C — vLLM (only if you actually need batching)

vLLM shines for serving many concurrent requests with PagedAttention. For your 5-10 queries/day, **overkill**. Skip unless you're running batch evals or serving multiple users. If you do go this route:

```bash
pip install vllm

vllm serve <model-id-or-path> \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --port 8000
```

Tool-call parser is per model family — `hermes` for Qwen3, `mistral` for Mistral, etc. Wrong parser = silently broken tool calls. See [vllm tool calling docs](https://docs.vllm.ai/en/latest/features/tool_calling.html).

---

## Step 6 — Run pi-mono coding agent locally on the GB10

This is the **primary goal**: drive coding tasks in the GB10 terminal with the local LLM doing the work. No Telegram, no daemon — just `pi` in your shell.

### 6.1 — Install Node + pi-mono

```bash
# Node 20+ (Ubuntu's apt has older versions; use NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# pi-mono (the actual coding agent CLI)
npm install -g @mariozechner/pi-coding-agent

# Verify
pi --version
```

### 6.2 — Configure pi-mono to talk to your local server

pi-mono reads `~/.pi/agent/models.json`. Use one of the templates from this repo as a starting point:

```bash
# Clone this repo (the config + helper scripts)
cd ~
git clone https://github.com/sergiopena/pi-local-llm-provider.git
cd pi-local-llm-provider

# Pick the example matching your Step 5 choice
mkdir -p ~/.pi/agent
cp examples/models.unsloth-studio.json ~/.pi/agent/models.json
# OR if you went with llama-server / vLLM:
# cp examples/models.vllm.json ~/.pi/agent/models.json
```

Edit `~/.pi/agent/models.json`:
- **`baseUrl`**: `http://localhost:8888/v1` (Studio) or `:8080/v1` (llama-server) or `:8000/v1` (vLLM)
- **`models[].id`**: the model name your server reports at `/v1/models`
- **`models[].name`**: friendly display name (whatever you want — shows in pi's banner)
- **`models[].contextWindow`**: match your `--ctx-size` (default 32768 is a good starting point)

If `~/.pi/agent/models.json` already exists from a prior pi install, merge by hand — pi-mono accepts multiple providers in one file.

### 6.3 — Verify tool-calling works (the load-bearing pre-flight)

pi-mono lives or dies on whether the LLM emits **structured tool_calls** (not text-form `<tool_call>` tags inside content). The probe is 30 lines, zero deps, exits 0 = ship it:

```bash
cd ~/pi-local-llm-provider   # or wherever you cloned
node scripts/probe-toolcalls.js \
  PROBE_ENDPOINT=http://localhost:8888/v1 \
  PROBE_MODEL=<your-model-id> \
  PROBE_API_KEY=any
# expect: exit 0
```

Common probe failures:
- `<tool_call>` text leaked into content → add `--chat-template qwen` (or your model's family) to llama-server, or pick a different model on Studio
- Empty `tool_calls[]` → wrong tool-call parser; check vLLM's `--tool-call-parser <parser>` flag
- Auth error → `PROBE_API_KEY` value mismatch with what the server expects (Studio: any string works; llama-server: usually no auth; vLLM: matches `--api-key`)

### 6.4 — Launch the coding agent

Use the safer launcher (runs `check-env.js` first to fail-closed if any env-var-named `apiKey` is unset):

```bash
~/pi-local-llm-provider/scripts/pi-launch.sh
```

OR if you trust your env (and don't have any env-var-resolved apiKey fields):
```bash
pi
```

You should land in the pi REPL. Try a coding task:
```
> read the file ./README.md and summarize the install steps in 3 bullets
```

If pi reads the file via its `read` tool and summarizes — **the loop is closed**. You're running a fully local coding agent on the GB10.

### 6.5 — That's the v1 done. Track 2 (Telegram comms) is later.

Once §6.4 works on GB10, you have the primary goal. Track 2 (the long-running comms daemon that exposes pi-mono via Telegram/WhatsApp) is documented at the repo root README and lives in `src/`. Skip until you've actually used the local CLI for a few days and know what you want from the remote channel.

---

## Step 7 — Run your first fine-tune (optional but satisfying)

A 30-min QLoRA on a tiny dataset to confirm training works:

```python
# save as train_smoke.py
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

model, tokenizer = FastLanguageModel.from_pretrained(
    "unsloth/Qwen2.5-7B-bnb-4bit",
    max_seq_length=2048,
    load_in_4bit=True,
)

# QLoRA — ~1% of params trainable
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    lora_alpha=16,
)

# Tiny dataset — Alpaca-format instructions
ds = load_dataset("yahma/alpaca-cleaned", split="train[:500]")
def fmt(ex):
    return {"text": f"### Instruction:\n{ex['instruction']}\n\n### Response:\n{ex['output']}"}
ds = ds.map(fmt)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=ds,
    args=SFTConfig(
        per_device_train_batch_size=4,
        gradient_accumulation_steps=4,
        max_steps=60,
        learning_rate=2e-4,
        output_dir="outputs/smoke",
        logging_steps=10,
    ),
)
trainer.train()
model.save_pretrained_merged("outputs/qwen-smoke", tokenizer, save_method="merged_4bit")
print("✅ training pipeline works end-to-end")
```

```bash
python train_smoke.py
```

If you see loss decreasing and `outputs/qwen-smoke/` populated with model files, your end-to-end fine-tune flow is operational.

---

## Common pitfalls + fixes

| Symptom | Fix |
|---|---|
| `torch.cuda.is_available() == False` | Driver too old. `sudo apt install nvidia-driver-555` + reboot |
| `bitsandbytes` import error | `pip install bitsandbytes --no-binary :all:` |
| `flash-attn` build hangs | Reduce `MAX_JOBS=2` or `MAX_JOBS=1` if RAM-constrained during build |
| Model load OOM | Lower `load_in_4bit=True` to use Q4 instead of Q8; or pick a smaller model |
| `llama-server` ignores tool calls | Add `--jinja --chat-template <model>` matching your model family |
| pi-local says `daemon_unreachable` | Check firewall + `baseUrl` matches what `curl /v1/models` returns |
| Studio says "model loaded" but inference returns garbage | GGUF quant + chat template mismatch — re-download with the model's recommended quant |
| ARM64 wheel not found for some package | `pip install <pkg> --no-binary :all:` to force source build |

---

## Daily operation cheat sheet

```bash
# Activate env
source ~/projects/gb10-unsloth/.venv/bin/activate

# Start inference server (one of:)
./unsloth-studio-*.AppImage                    # GUI
./llama.cpp/build/bin/llama-server --model ... # headless

# Run a training job
python train_my_thing.py

# Check GPU utilization while training
watch -n 1 nvidia-smi
```

Stop server: Ctrl+C in its terminal. Stop training: Ctrl+C in its terminal. They're independent.

---

## What to track for v0.2 of this runbook

- Actual GB10 driver / CUDA version that worked (fill in once you have the hardware)
- ARM64 wheel install times (so you have realistic estimates)
- Tool-call parser that worked for your specific model family
- Whether DGX OS or vanilla Ubuntu won out

Document in this file as you learn. Future-you (and any agent picking this up) will thank present-you.

---

*Saved 2026-05-06. Pre-arrival of GB10. Update with real numbers once the box ships.*
