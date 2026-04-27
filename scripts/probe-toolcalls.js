#!/usr/bin/env node
/**
 * Probe: does this OpenAI-compat endpoint emit structured tool_calls[] for
 * a tool-capable local model?
 *
 * Why this matters: pi-mono parses tool calls ONLY from the OpenAI-shaped
 * `choice.delta.tool_calls[]` field. If your local server emits the model's
 * tool intent as `<tool_call>...</tool_call>` text inside `delta.content`,
 * pi will treat it as chat prose and the agent loop never runs the tool.
 *
 * PASS exit 0 = backend usable as a pi-mono custom provider for tool-calling
 * FAIL exit 1 = leaks as text OR no tool call emitted at all
 * ERR  exit 2 = configuration / connectivity problem; see stderr
 *
 * Defaults probe Unsloth Studio at localhost:8888. Override via env vars:
 *   PROBE_ENDPOINT  (default: http://localhost:8888/v1)
 *   PROBE_MODEL     (default: unsloth/Qwen3.6-27B-GGUF)
 *   PROBE_API_KEY   (default: $UNSLOTH_API_KEY)
 *
 * Examples:
 *   UNSLOTH_API_KEY=sk-unsloth-... node scripts/probe-toolcalls.js
 *   PROBE_ENDPOINT=http://localhost:11434/v1 PROBE_MODEL=qwen2.5:14b \
 *     PROBE_API_KEY=ollama node scripts/probe-toolcalls.js
 */

const ENDPOINT = process.env.PROBE_ENDPOINT || "http://localhost:8888/v1";
const MODEL = process.env.PROBE_MODEL || "unsloth/Qwen3.6-27B-GGUF";
const API_KEY = process.env.PROBE_API_KEY || process.env.UNSLOTH_API_KEY;

if (!API_KEY) {
  console.error(
    "ERR: no API key. Set PROBE_API_KEY or UNSLOTH_API_KEY in env.",
  );
  console.error("     For Ollama, any non-empty string works (e.g. 'ollama').");
  process.exit(2);
}

const url = `${ENDPOINT.replace(/\/+$/, "")}/chat/completions`;

const body = {
  model: MODEL,
  messages: [
    {
      role: "system",
      content:
        "You are a helpful assistant. When the user asks for the weather, " +
        "you MUST call the get_weather tool with the city name.",
    },
    {
      role: "user",
      content: "What is the weather in Oakland, CA?",
    },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "city name" },
          },
          required: ["city"],
        },
      },
    },
  ],
  stream: false,
  temperature: 0.0,
  max_tokens: 512,
};

console.log(`--- Probing ${url}`);
console.log(`    model: ${MODEL}`);

let resp;
try {
  resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
} catch (err) {
  console.error(`ERR: connection failed: ${err.message}`);
  console.error(`     Is the server running at ${ENDPOINT}?`);
  process.exit(2);
}

if (!resp.ok) {
  const text = await resp.text();
  console.error(`ERR: HTTP ${resp.status} ${resp.statusText}`);
  console.error(text.slice(0, 600));
  process.exit(2);
}

const json = await resp.json();
const choice = json.choices?.[0];
const message = choice?.message;
const toolCalls = message?.tool_calls;
const content = message?.content || "";

console.log("\n--- Probe result");
console.log(`finish_reason: ${choice?.finish_reason ?? "(missing)"}`);
console.log(`tool_calls:    ${JSON.stringify(toolCalls, null, 2)}`);
console.log(`content (head): ${JSON.stringify(content.slice(0, 200))}`);

const hasStructured =
  Array.isArray(toolCalls) &&
  toolCalls.length > 0 &&
  toolCalls[0].function?.name === "get_weather";
const hasTextLeak = /<tool_call/i.test(content);

let argsParse = false;
let argsCity = null;
if (hasStructured) {
  try {
    const args = JSON.parse(toolCalls[0].function.arguments || "{}");
    argsCity = args.city;
    argsParse = typeof argsCity === "string" && argsCity.length > 0;
  } catch {
    argsParse = false;
  }
}

console.log("\n--- Verdict");
if (hasStructured && !hasTextLeak && argsParse) {
  console.log(`PASS — backend emits structured tool_calls[] (city='${argsCity}').`);
  console.log("       pi-mono Tier 0 is viable. Drop a models.json entry and ship.");
  process.exit(0);
}

if (hasTextLeak) {
  console.log("FAIL — backend leaked <tool_call> as text inside content.");
  console.log("       pi-mono cannot parse this — it expects structured");
  console.log("       choice.message.tool_calls[]. Possible fixes:");
  console.log("         (a) For Studio: file an upstream issue or wait for a build");
  console.log("             that runs llama.cpp with --jinja + Qwen3 tool-call parser.");
  console.log("         (b) Pivot to Ollama qwen2.5:14b (mature OpenAI-shaped tools).");
  console.log("         (c) Run llama-server directly with --jinja + --tool-call-parser qwen.");
  process.exit(1);
}

if (!hasStructured) {
  console.log("FAIL — model did not call the tool at all.");
  console.log("       Possible causes:");
  console.log("         * Reasoning chain intercepting the tool-call grammar.");
  console.log("           Re-run with the model's /no_think marker if applicable.");
  console.log("         * Server didn't forward tools[] in the prompt template.");
  console.log("           Check the server's chat template supports tool-augmented prompts.");
  console.log("         * Model wasn't fine-tuned for tool-calling.");
  process.exit(1);
}

console.log("FAIL — partial pass (tool_calls present but malformed). Investigate manually.");
process.exit(1);
