# RFC: Local OpenAI-compat servers as documented pi-mono custom providers

**Status:** Draft (lift-and-ship — paste body into a pi-mono PR description when ready)
**Author:** Sergio Pena ([@KanuToCL](https://github.com/KanuToCL))
**Targets:** `packages/coding-agent/docs/models.md` + `packages/coding-agent/docs/custom-provider.md`
**Type:** Documentation-only

---

## Summary

Document Unsloth Studio, Ollama, LM Studio, and vLLM as tested OpenAI-compat custom-provider targets for pi-mono, including:

- Reference `~/.pi/agent/models.json` entries per backend
- Required `compat` flags (e.g., `thinkingFormat: "qwen-chat-template"` for Qwen3 served by Studio)
- A 30-LOC probe script users run **before** committing to a backend
- Documented failure modes ("server leaked `<tool_call>` as text" → pivot recommendations)

No code changes to pi-mono. Pure documentation contribution.

## Motivation

pi-mono's `BYO model` story works trivially for cloud APIs (Anthropic, OpenAI, Gemini) but local LLM servers have undocumented quirks that a first-time user hits in their first 30 minutes:

1. **Unsloth Studio silently drops `chat_template_kwargs`** unless the request goes through pi-mono's `qwen-chat-template` compat path. New users adding Studio via `models.json` without the compat flag get partial-functioning Qwen3 (no thinking suppression).
2. **Ollama needed v0.3+ for OpenAI-shaped tool calls** in the `/v1/chat/completions` route. Earlier versions emit tool intent as text inside `delta.content`, which pi-mono cannot parse.
3. **Tool-call response shape varies by server + chat-template + model fine-tune combination.** A Qwen3 model that emits structured `tool_calls[]` from one server may emit `<tool_call>...</tool_call>` text from another. pi-mono's parser at `packages/ai/src/providers/openai-completions.ts:297-346` reads only the structured field, so the text-leak failure mode is silent (the agent runs but never invokes the tool).

A user who attempts the integration without these warnings either (a) gives up and assumes pi-mono doesn't support local models, or (b) ships a half-broken setup and discovers the tool-call gap after wasted effort.

## Proposed addition

A new "Local OpenAI-compat providers" section in `packages/coding-agent/docs/models.md` covering:

### Per-backend reference configs

For each of Unsloth Studio, Ollama, LM Studio, vLLM:
- Minimal `~/.pi/agent/models.json` entry
- Required `compat` flags
- Known quirks (silent-drop fields, version requirements)
- Tested model + setup recipe

### A pre-flight probe

A 30-LOC standalone Node script (`tools/probe-local-toolcalls.js` or similar in pi-mono's repo, OR linked from an external repo like [pi-local-llm-provider](https://github.com/KanuToCL/pi-local-llm-provider)). Sends one tool-augmented request and asserts:

```
PASS  = choice.message.tool_calls[0].function.name === "get_weather"
        AND choice.message.content does NOT contain "<tool_call>"
        AND choice.message.tool_calls[0].function.arguments parses as JSON
```

Exit code 0 = backend usable. Exit code 1 = backend not usable for tool-calling, with diagnostic output identifying which failure mode (text leak vs no tool call at all) and recommended pivot.

### Tool-call format documentation

A new subsection in `packages/coding-agent/docs/custom-provider.md` explicitly stating:

> pi-mono parses tool calls only from `choice.delta.tool_calls[]` (the OpenAI structured field). It does NOT scan `delta.content` for Hermes-style `<tool_call>...</tool_call>` text blocks. If your custom provider's server emits tool calls as text inside content, the agent loop will not invoke the tool. Test with the probe script before relying on the integration.

This sets correct expectations and prevents the "I added the config and pi still won't run my tools" support burden.

## Why not built-in registration

Adding a built-in provider via `packages/ai/src/providers/register-builtins.ts` couples pi-mono's release cadence to that backend's. Studio, Ollama, LM Studio, and vLLM each move on their own schedules. The existing `compat`-driven `models.json` mechanism already handles every quirk identified above; no new code is needed in pi-mono. Documentation-only is the lowest-overhead contribution.

If a particular backend acquires a critical mass of pi-mono users AND develops quirks that `compat` flags cannot express (i.e., requires per-call request-body mutation), built-in registration becomes the right move. Today none of the four backends are at that threshold for pi-mono.

## Why not request-body-mutator hooks

A more invasive alternative would be to extend `compat` with a `requestPayloadModifier` callback so users could patch the outgoing request shape per provider. This was considered and deferred:

- Increases attack surface (arbitrary user code in the request hot path)
- Adds testing burden (every provider's modifier needs validation)
- Documentation + probe achieves 90% of the value for 10% of the complexity

If documentation proves insufficient (i.e., a backend genuinely requires mid-request mutation that `compat` flags cannot express), revisit then.

## Maintenance burden

Documentation-only. Annual review: re-run the probes against latest versions of each backend, update the matrix. ~1 hour/year if no quirks change.

If the upstream openai-completions provider evolves in a way that breaks the documented `compat` recipes, the probes immediately surface it on next run.

## Acknowledgments

This RFC was drafted alongside [pi-local-llm-provider](https://github.com/KanuToCL/pi-local-llm-provider), which collects the empirical findings and the probe script. The author maintains that repo as a single-user-of-public-record reference; this RFC proposes folding the documented patterns into pi-mono's official docs to reach a wider audience.

## Open questions for reviewer

1. Should the probe script live IN pi-mono (`tools/probe-local-toolcalls.js`) or stay in the external repo and be linked from the docs?
2. Naming: "Local OpenAI-compat providers" section title vs "Self-hosted providers" vs other?
3. Should the doc explicitly recommend Ollama over Studio (more mature tool-calling) or stay neutral and let the probe decide?

---

*If you're reading this from inside the pi-local-llm-provider repo: this is the upstream PR description draft. Lift the body verbatim into a pi-mono PR when the probe at [`scripts/probe-toolcalls.js`](./scripts/probe-toolcalls.js) has been validated against multiple backends and the README's supported-backends matrix is filled in.*
