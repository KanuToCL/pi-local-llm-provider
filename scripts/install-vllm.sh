#!/usr/bin/env bash
# install-vllm.sh — opt-in vLLM toolchain installer for pi-local-llm-provider.
#
# Per Ring of Elders v0.3.1 plan §F7 (see
# docs/plans/pi_comms_v0_3_1_telegram_polish_and_vllm_optin.plan.md).
#
# What this does:
#   • Refuse to run on non-Linux (vLLM has no macOS/Windows builds).
#   • Detect CUDA via nvidia-smi (warn-only — does not refuse, since
#     CPU-only vLLM exists for tinkering).
#   • Create ~/.venvs/vllm/ as an isolated venv (so vLLM's torch pin
#     does not collide with other Python projects).
#   • pip install "vllm==0.6.5" — VERSION IS PINNED. Bumping requires
#     re-running scripts/probe-toolcalls.js to confirm tool calls still
#     emit OpenAI-shaped tool_calls[]. See README §"Why the probe".
#   • Print a recommended `vllm serve` invocation tailored to detected
#     GPU memory.
#
# What this does NOT do:
#   • Auto-run `vllm serve`. The user launches that themselves.
#   • Touch ~/.pi/agent/models.json. That's a separate manual step
#     (see docs/INSTALL-VLLM.md §6).
#   • Set VLLM_API_KEY. The user exports that themselves (§6 too).
#
# Idempotency posture:
#   • Re-running is safe. If the venv exists, skip creation. If vllm
#     is already installed at the pinned version, skip pip install.
#   • Dry-run mode (`-n`) prints the commands without executing any
#     of them. NO `pip install` runs in dry-run mode.
#
# Usage:
#   scripts/install-vllm.sh           # real install
#   scripts/install-vllm.sh -n        # dry run — print commands only
#   scripts/install-vllm.sh --help    # show this header
#
# Env overrides:
#   VLLM_VENV_DIR    venv path (default: ~/.venvs/vllm)
#   VLLM_VERSION     pinned version (default: 0.6.5 — bump requires re-probe)

set -euo pipefail

VLLM_VERSION_PINNED="${VLLM_VERSION:-0.6.5}"
VENV_DIR="${VLLM_VENV_DIR:-${HOME}/.venvs/vllm}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,45p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "install-vllm: unknown flag: $arg" >&2
      echo "             try: install-vllm.sh --help" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Platform gate — vLLM is Linux-only (no macOS/Windows wheels).
# Dry-run bypasses the gate (mirrors scripts/install-systemd.sh) so docs +
# CI can dump the recommended invocation from any host.
# ---------------------------------------------------------------------------
UNAME_S="$(uname -s)"
if [[ "${UNAME_S}" != "Linux" && "${DRY_RUN}" -ne 1 ]]; then
  echo "install-vllm: REFUSING to install — vLLM is Linux-only" >&2
  echo "             (this host is ${UNAME_S})." >&2
  echo "" >&2
  echo "  vLLM does not publish macOS or Windows wheels. On macOS or" >&2
  echo "  Windows, use Unsloth Studio instead (see README §'Probe results'" >&2
  echo "  and examples/models.unsloth-studio.json)." >&2
  echo "" >&2
  echo "  See docs/INSTALL-VLLM.md §1 for the decision tree." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# CUDA detection — warn-only. vLLM has a CPU-only mode but it's unusable
# for anything but the smallest models. We warn so the user understands
# why their first request takes 4 minutes.
# ---------------------------------------------------------------------------
detect_cuda() {
  if command -v nvidia-smi > /dev/null 2>&1; then
    if nvidia-smi > /dev/null 2>&1; then
      # Capture VRAM of GPU 0 in MiB for the recommended-flags hint.
      DETECTED_VRAM_MIB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2> /dev/null | head -1 | tr -d ' ' || true)"
      DETECTED_GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2> /dev/null | head -1 || true)"
      if [[ -n "${DETECTED_VRAM_MIB}" ]]; then
        echo "install-vllm: detected GPU: ${DETECTED_GPU_NAME} (${DETECTED_VRAM_MIB} MiB VRAM)"
        return 0
      fi
    fi
  fi
  echo "install-vllm: WARN — no CUDA / nvidia-smi detected." >&2
  echo "             vLLM will fall back to CPU-only mode. This is" >&2
  echo "             technically supported but performance will be" >&2
  echo "             unusable for anything but the smallest models." >&2
  echo "             If you have a GPU but nvidia-smi is missing, install" >&2
  echo "             the NVIDIA driver before continuing." >&2
  DETECTED_VRAM_MIB=""
  DETECTED_GPU_NAME="(none — CPU-only mode)"
  return 0
}

# ---------------------------------------------------------------------------
# Pick a recommended --gpu-memory-utilization based on detected VRAM.
# Conservative defaults so a user co-running anything else on the GPU
# doesn't OOM. See docs/INSTALL-VLLM.md §7 (GPU contention warning).
# ---------------------------------------------------------------------------
recommend_gpu_util() {
  if [[ -z "${DETECTED_VRAM_MIB}" ]]; then
    echo ""
    return 0
  fi
  if [[ "${DETECTED_VRAM_MIB}" -ge 49152 ]]; then
    # 48+ GiB: H100 / A100 / GB10 — give vLLM almost everything.
    echo "0.90"
  elif [[ "${DETECTED_VRAM_MIB}" -ge 24576 ]]; then
    # 24-48 GiB: 5090 / 4090 / A6000 — leave headroom.
    echo "0.85"
  elif [[ "${DETECTED_VRAM_MIB}" -ge 16384 ]]; then
    # 16-24 GiB: 4080 / 3090Ti — tighter.
    echo "0.80"
  else
    # < 16 GiB: not really enough for a 27B model, but be conservative.
    echo "0.70"
  fi
}

# ---------------------------------------------------------------------------
# Resolve a Python interpreter. Prefer python3.12 (the version vLLM 0.6.5
# wheels target); fall back to python3 with a warning.
# ---------------------------------------------------------------------------
resolve_python() {
  if command -v python3.12 > /dev/null 2>&1; then
    PY_BIN="$(command -v python3.12)"
  elif command -v python3 > /dev/null 2>&1; then
    PY_BIN="$(command -v python3)"
    PY_VERSION="$("${PY_BIN}" --version 2>&1 | awk '{print $2}')"
    echo "install-vllm: WARN — python3.12 not found; using ${PY_BIN} (${PY_VERSION})." >&2
    echo "             vLLM 0.6.5 wheels target Python 3.12. Other versions" >&2
    echo "             may work but are unverified." >&2
  else
    echo "install-vllm: REFUSING — no python3 / python3.12 on PATH." >&2
    echo "             Install Python 3.12 (e.g. apt install python3.12-venv)" >&2
    echo "             before re-running." >&2
    exit 2
  fi
}

# ---------------------------------------------------------------------------
# Create venv (idempotent — skip if already present and looks valid).
# ---------------------------------------------------------------------------
create_venv() {
  if [[ -x "${VENV_DIR}/bin/python" ]]; then
    echo "install-vllm: venv already exists at ${VENV_DIR} — skipping creation."
    return 0
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would: ${PY_BIN} -m venv ${VENV_DIR}"
    return 0
  fi
  mkdir -p "$(dirname "${VENV_DIR}")"
  "${PY_BIN}" -m venv "${VENV_DIR}"
  echo "install-vllm: created venv at ${VENV_DIR}"
}

# ---------------------------------------------------------------------------
# Install pinned vLLM (idempotent — skip if already at the pinned version).
# ---------------------------------------------------------------------------
install_vllm_pkg() {
  local pip_bin="${VENV_DIR}/bin/pip"
  local installed_version=""
  if [[ -x "${pip_bin}" ]]; then
    installed_version="$("${pip_bin}" show vllm 2> /dev/null | awk '/^Version:/ {print $2}' || true)"
  fi
  if [[ "${installed_version}" == "${VLLM_VERSION_PINNED}" ]]; then
    echo "install-vllm: vllm==${VLLM_VERSION_PINNED} already installed — skipping."
    return 0
  fi
  if [[ -n "${installed_version}" ]]; then
    echo "install-vllm: replacing vllm ${installed_version} with pinned ${VLLM_VERSION_PINNED}."
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would: ${pip_bin} install --upgrade pip"
    echo "[dry-run] would: ${pip_bin} install \"vllm==${VLLM_VERSION_PINNED}\""
    echo "[dry-run] (NO pip install actually runs in dry-run mode)"
    return 0
  fi
  "${pip_bin}" install --upgrade pip
  "${pip_bin}" install "vllm==${VLLM_VERSION_PINNED}"
  echo "install-vllm: installed vllm==${VLLM_VERSION_PINNED}"
}

# ---------------------------------------------------------------------------
# Print the recommended `vllm serve` invocation for the user to run
# themselves. We do NOT auto-run it.
# ---------------------------------------------------------------------------
print_serve_hint() {
  local gpu_util
  gpu_util="$(recommend_gpu_util)"
  local util_flag=""
  if [[ -n "${gpu_util}" ]]; then
    util_flag=" \\
    --gpu-memory-utilization ${gpu_util}"
  fi
  cat <<EOF

install-vllm: install complete (or simulated, if --dry-run).
              vLLM version pinned at ${VLLM_VERSION_PINNED}; bumping requires
              re-running \`node scripts/probe-toolcalls.js\` to confirm tool
              calls still emit OpenAI-shaped tool_calls[].

Detected GPU: ${DETECTED_GPU_NAME}

Next step — launch vLLM YOURSELF (this script does NOT auto-run it):

    source ${VENV_DIR}/bin/activate

    vllm serve Qwen/Qwen3.6-27B-Instruct \\
        --host 127.0.0.1 \\
        --port 8000 \\
        --enable-auto-tool-choice \\
        --tool-call-parser hermes \\
        --served-model-name Qwen/Qwen3.6-27B-Instruct \\
        --api-key "\${VLLM_API_KEY}"${util_flag}

  • --host 127.0.0.1 is REQUIRED (R9 mitigation — see SECURITY.md).
    vLLM defaults to 0.0.0.0; do NOT bind that on a multi-tenant LAN.
  • --tool-call-parser hermes is correct for Qwen3-class. For other
    model families, see https://docs.vllm.ai/en/latest/features/tool_calling.html

Then probe:

    VLLM_API_KEY=<your-key> \\
    PROBE_ENDPOINT=http://localhost:8000/v1 \\
    PROBE_MODEL=Qwen/Qwen3.6-27B-Instruct \\
    node scripts/probe-toolcalls.js

If exit 0, copy examples/models.vllm.json to ~/.pi/agent/models.json
(chmod 600), then export VLLM_API_KEY in your shell rc.

Full guide: docs/INSTALL-VLLM.md.

EOF
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "install-vllm: DRY RUN — no commands will be executed."
  echo ""
fi

detect_cuda
resolve_python
create_venv
install_vllm_pkg
print_serve_hint
