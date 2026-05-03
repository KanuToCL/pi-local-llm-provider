# Contributing

Four useful kinds of contribution, in increasing order of effort:

1. [**Probe verdict**](#1-probe-verdict-most-useful) for a backend you've
   tested — confirms or expands the support matrix.
2. [**Backend example**](#2-backend-example) — a `models.json` skeleton for a
   backend not yet covered.
3. [**Quirk documentation**](#3-quirk-documentation) — something broke for
   you, here's what / why / fix.
4. [**Security finding**](#4-security-finding) — see [`SECURITY.md`](./SECURITY.md).

This is a single-maintainer repo. Please keep PRs focused (one concern per PR)
and include the reproduction context — there is no CI yet, so the maintainer
re-runs your probe locally before merging.

---

## 1. Probe verdict (most useful)

The "Probe results" matrix in the README is the actual source of truth for
"what works on what hardware." If you've run the probe against a backend +
model + hardware combination not in the table, please add a row.

### Submit by issue or PR

**Easiest:** open an issue titled `Probe verdict: <backend> <model>` and paste
this template:

```
Backend:        <Unsloth Studio | Ollama | LM Studio | vLLM | other>
Backend version: <e.g. unsloth-studio 0.4.2 / ollama 0.5.4 / lm-studio 0.3.x / vllm 0.6.x>
Model id:       <e.g. unsloth/Qwen3.6-27B-GGUF>
Quant / variant: <e.g. UD-Q4_K_XL — read via scripts/studio-variant.js for Studio>
Model size on disk: <e.g. ~16 GB>

Hardware:       <e.g. RTX 5070, 12 GB VRAM, 32 GB system RAM>
OS:             <e.g. Windows 11 / macOS 14.x / Ubuntu 22.04>
pi-mono version: <e.g. @mariozechner/pi-coding-agent 0.70.6>

Probe command:
$ <full command you ran>

Probe output (full):
<paste stdout + stderr>

Verdict:        <PASS | FAIL with text leak | FAIL with no tool call>
Notes:          <optional — e.g. "had to launch with --jinja", "needed Q4_K_XL or above">

GitHub handle:  <@yourhandle — for matrix attribution>
Date:           <YYYY-MM-DD>
```

**By PR:** edit the matrix in [`README.md`](./README.md) directly. Use the
columns documented there. Link the PR back to your reproducible probe output
(a gist of the full terminal session is fine; see SECURITY.md before pasting
anything from a session that touched secrets).

### What "PASS" actually means

The probe passes if and only if all three are true (see
[`scripts/probe-toolcalls.js`](./scripts/probe-toolcalls.js)):

1. `choices[0].message.tool_calls[0].function.name === "get_weather"`
2. `choices[0].message.content` does not contain `<tool_call`
3. `choices[0].message.tool_calls[0].function.arguments` is parseable JSON
   with a non-empty `city` field

A PASS is necessary but not sufficient — multi-arg tool calls (the `edit`
failure mode noted in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §6)
are not yet covered by the probe. Note any multi-arg degradation you see
in the verdict notes.

---

## 2. Backend example

If you've made a backend work that this repo doesn't yet ship a config for,
add it.

### File layout

- Place the JSON at `examples/models.<backend-id>.json`.
- The first key MUST be `_comment` describing pre-requisites and pointing at
  the schema doc — see existing files for the pattern.
- Stick to the schema documented in
  [`README.md`](./README.md) "Schema notes (pi-mono ≥ 0.70)" — `api` (not
  `type`), `apiKey` is an env-var name (no `$` prefix) or `!shellcmd`,
  `cost` is required (zeros for local), `tools` is not a field.

### Mandatory checklist before opening the PR

- [ ] `node scripts/probe-toolcalls.js` passes against your backend with the
      example loaded (paste the exit-0 output in the PR description).
- [ ] `~/.pi/agent/models.json` contains your example or a merged copy with
      `chmod 600` applied; pi shows your model in `pi --list-models`.
- [ ] You ran one real `pi --provider <id>` request end-to-end (e.g. "list
      files in this dir") and pi invoked at least one tool successfully.
- [ ] [`README.md`](./README.md) "Probe results" matrix has a row for this
      backend (status: passing or untested-skeleton).
- [ ] [`SECURITY.md`](./SECURITY.md) "Backend-specific considerations" has a
      paragraph for this backend if it has non-obvious behavior (default
      bind address, auth shape, known quirks).
- [ ] No external `import`/`require` calls beyond `node:` stdlib in any
      script you ship — keep the dep surface zero.

---

## 3. Quirk documentation

Hit something that wasted your time? Save the next person.

- For backend-side quirks (chat-template behavior, version-dependent tool
  calling), add a paragraph to [`docs/DESIGN.md`](./docs/DESIGN.md) §3 or
  "Backend-specific" in [`SECURITY.md`](./SECURITY.md).
- For pi-mono ↔ backend interaction quirks (the `<tool_call>` text-leak
  family, the multi-arg JSON degradation family), add to
  [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §6 "Failure-mode
  reference."
- For schema-drift findings (a pi-mono release that breaks a `models.json`
  field), open an issue and the maintainer will roll the README "Schema
  notes" forward.

Include the version pair (pi-mono X.Y.Z + backend A.B.C) so the note can be
rotated when versions advance.

---

## 4. Security finding

See [`SECURITY.md`](./SECURITY.md). Open a GitHub security advisory for
anything that exposes a credential or executes arbitrary code; open a regular
issue for hardening suggestions or doc clarifications.

---

## Code style

The repo is intentionally tiny and dependency-free. Keep it that way.

### Bash

- `#!/usr/bin/env bash` at the top
- `set -euo pipefail` immediately after
- Pass [shellcheck](https://www.shellcheck.net/) clean (no exceptions; if you
  need an exception, comment why with the SC code)
- Quote every variable expansion (`"${var}"`, not `$var`)
- Detect script dir with the canonical `cd -- "$(dirname -- "${BASH_SOURCE[0]}")"`
  idiom — works on macOS and Linux

### Node

- ESM only (`type: "module"` is set in `package.json`)
- Node 20+ syntax; top-level `await` is fine
- Standard library only — no `npm install`
- Prefix stdlib imports with `node:` (`node:fs`, `node:path`, `node:os`)
- Prefer `process.exit(<code>)` with the documented exit-code contract over
  thrown exceptions for CLI tools

### TypeScript extensions

- ESM, default-export the function
- Type imports only from `@mariozechner/pi-coding-agent`
- No external runtime deps — same standard-library-only rule as Node
- Document the install path (`~/.pi/agent/extensions/<name>.ts`) at the top

### JSON

- 2-space indent
- Top-level `_comment` field documenting pre-requisites and schema reference
- No trailing commas (the file is consumed by pi-mono's strict JSON parser)

### Markdown

- One sentence per line in narrative paragraphs is fine but not required —
  match the surrounding file
- Code fences specify language for syntax highlighting (`bash`, `json`,
  `javascript`, etc.)
- Cross-link related docs with relative paths

---

## Out of scope

This repo deliberately stays small. The maintainer will close PRs that:

- Add a runtime npm dependency (the probe + helpers are zero-dep on purpose)
- Patch pi-mono internals (file an upstream PR; see [`RFC.md`](./RFC.md) for
  the docs-only contribution path)
- Add channel adapters, multi-user routing, or sandbox enforcement (those
  belong in OpenClaw — see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
  Layer 4)
- Add a backend-daemon installer (that's the backend project's job)
- Add a fine-tuning pipeline or RAG layer (different repos; see the author's
  vibration-pdm for one example)
- Build a Tier-1 npm wrapper around the configs ([`docs/DESIGN.md`](./docs/DESIGN.md)
  §2.3 explains why this is intentional)

---

## Author / maintainer

Sergio Pena ([sergiopena.audio](https://sergiopena.audio) · [@KanuToCL](https://github.com/KanuToCL)).
Single-maintainer repo, best-effort response time. Be patient and specific
and your PR will land.
