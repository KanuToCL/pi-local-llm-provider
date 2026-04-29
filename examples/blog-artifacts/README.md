# Blog artifacts — local agent output

Real output produced by the four-layer stack documented in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md):

```
Unsloth Studio (UD-Q4_K_XL) ── /v1 ──► pi-mono ──► write tool ──► caterpillars.html
```

## Files

| File | What it is |
|------|------------|
| `caterpillars.html` | A 506-line, self-contained, single-file HTML page about the caterpillar life cycle. Generated end-to-end by Qwen3.6-27B-GGUF (UD-Q4_K_XL variant) running locally in Unsloth Studio, driven by pi-mono v0.70.6. No internet calls during generation; the only external resource the page itself loads is the Nunito font from Google Fonts at view time. |
| `caterpillars-rendered.png` | Screenshot of the pi session terminal at the end of the run, showing the agent's description of what it built. |

## How it was generated

```bash
pi --provider unsloth-studio --model "unsloth/Qwen3.6-27B-GGUF" \
   "write a stylish self-contained HTML page about caterpillar life cycles"
```

The first attempt used the `edit` tool against a partial file and ran into the failure mode documented in [`docs/ARCHITECTURE.md` §6](../../docs/ARCHITECTURE.md) (multi-arg JSON tool calls degrade on quantized models). The second attempt — phrased to push the model toward the `write` tool — completed cleanly.

## Why this matters

The page is not a Claude/GPT output. It was produced by:
- A 27B parameter model (Qwen3.6) at Q4 quantization (~16 GB on disk)
- Running on a single consumer GPU (RTX 5070 Ti, see screenshot)
- Through a local OpenAI-compatible endpoint at `localhost:8888`
- With zero cloud API calls during the agent loop

This is the kind of thing the stack documented in this repo is *for*: turning a local-model BYO setup into a working coding-agent loop without paying per-token rates for grunt work.

## Reuse

`caterpillars.html` is a self-contained file. Open it in any browser. No build step, no dependencies beyond the runtime Google Fonts request. Free to use under the same MIT license as the rest of this repo.
