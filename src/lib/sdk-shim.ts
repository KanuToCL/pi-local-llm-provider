/**
 * Defensive wrapper around `@mariozechner/pi-coding-agent`.
 *
 * Why a shim:
 *   - pi-coding-agent is in `optionalDependencies`. On dev machines (notably
 *     macOS without a local Studio install), the SDK is absent and a static
 *     `import { ... } from "@mariozechner/pi-coding-agent"` would crash module
 *     evaluation. We dynamic-import behind `loadSdk()` and surface a stable
 *     `SdkNotInstalledError` so callers (SessionManager.init()) can short-circuit
 *     with a clear diagnostic.
 *   - The W1 SDK spike (`scripts/sdk-spike.ts`, output at
 *     `~/.pi-comms/sdk-spike.json`) verified which assumed symbols actually
 *     exist on pi-mono ≥0.72. Notably `pi.registerTool` is ABSENT — the only
 *     working pattern is to pass tools via `customTools` to `createAgentSession`
 *     and subscribe to `AgentSessionEvent` via `session.subscribe(listener)`.
 *     This file documents which symbols we depend on and centralizes the
 *     "what does pi-mono actually export" mapping in one place.
 *   - pi-mono's `AgentSessionEvent` is a discriminated union over many event
 *     kinds (see `node_modules/.../core/agent-session.d.ts:40-72` and
 *     `pi-agent-core/dist/types.d.ts:330-368`). We map the subset relevant to
 *     channel sinks into our local `ChannelEvent` shape (from
 *     `src/tools/types.ts`); unknown / non-relevant kinds become `null` so
 *     SessionManager can drop them silently.
 *
 * Type opacity:
 *   - We do NOT `import type ...` from pi-coding-agent at the top level. Any
 *     such import would compile against the SDK's declared types, which on
 *     macOS-without-SDK would fall through to `any` (acceptable) but on
 *     Windows-with-SDK would lock us to its exact generic signatures (e.g.
 *     ToolDefinition's TypeBox `TSchema` constraint). Tools constructed by
 *     IMPL-8 are JSON-Schema-shaped, not TypeBox; structural compatibility
 *     is enforced at `customTools` registration time.
 *   - The `SdkLoaded` interface only declares functions whose runtime contract
 *     is stable (createAgentSession, defineTool). Other surface (resource
 *     loaders, model registries) is accessed off the loaded module as needed.
 */

import type { ChannelEvent } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Public — error types
// ---------------------------------------------------------------------------

/**
 * Thrown by `loadSdk()` when @mariozechner/pi-coding-agent cannot be imported
 * (typical: missing optional dependency on dev machines). Stable .name for
 * catch-by-name across module boundaries.
 */
export class SdkNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkNotInstalledError";
  }
}

// ---------------------------------------------------------------------------
// Public — loaded-SDK contract
// ---------------------------------------------------------------------------

/**
 * The minimum surface SessionManager pulls off pi-coding-agent. We type it
 * as `unknown`-returning functions because pi-mono's actual generics
 * (TSchema, AgentSession class) are too entangled with TypeBox for our
 * JSON-Schema-shaped tool definitions to satisfy without dragging in
 * additional dependencies. Runtime behavior is what matters; TypeScript only
 * needs to know "these are functions you can call".
 */
export interface SdkLoaded {
  /** `createAgentSession(opts)` — returns `{ session, ... }`. */
  createAgentSession: (opts: SdkCreateAgentSessionOptions) => Promise<{
    session: SdkAgentSession;
    [key: string]: unknown;
  }>;
  /** `defineTool(def)` — returns the tool definition annotated for pi-mono. */
  defineTool: (definition: unknown) => unknown;
  /** Raw module reference for any escape-hatch needs (e.g. ModelRegistry). */
  raw: Record<string, unknown>;
}

/**
 * Subset of pi-mono's `CreateAgentSessionOptions` we actually pass. We do NOT
 * require every field — pi-mono fills defaults from `~/.pi/agent/`. Open type
 * (extra keys allowed) so future plan revisions can add fields without
 * touching this shim.
 */
export interface SdkCreateAgentSessionOptions {
  cwd?: string;
  customTools?: unknown[];
  // Extra pi-mono options (model, agentDir, etc.) flow through as `unknown`.
  [key: string]: unknown;
}

/**
 * Subset of pi-mono's `AgentSession` we actually call. Adding methods here
 * is cheap (typed `unknown` if we don't care about return shape).
 */
export interface SdkAgentSession {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  abort(): Promise<void>;
  // Everything else (close, sessionManager, etc.) accessed via `as any`.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public — loadSdk()
// ---------------------------------------------------------------------------

/**
 * Dynamically import @mariozechner/pi-coding-agent. Throws
 * `SdkNotInstalledError` if the package is missing — callers wrap in try/catch
 * and surface a structured diagnostic to the operator (SessionManager.init()
 * does this, plus an OperatorLogger error event).
 *
 * The dynamic import deliberately uses a string literal that TypeScript's
 * module resolver will tolerate even when the package isn't installed,
 * because we type the result as `unknown` and re-narrow.
 */
export async function loadSdk(): Promise<SdkLoaded> {
  let mod: Record<string, unknown>;
  try {
    // The module name is the same string as the package name. We don't use
    // `import type` here because that would resolve against the SDK's .d.ts
    // (potentially missing) at compile time.
    mod = (await import("@mariozechner/pi-coding-agent")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new SdkNotInstalledError(
      `@mariozechner/pi-coding-agent is not installed (${cause}). ` +
        "Install via `npm install -g @mariozechner/pi-coding-agent` and " +
        "ensure your local Studio (or chosen provider) is reachable."
    );
  }

  const createAgentSession = mod.createAgentSession;
  const defineTool = mod.defineTool;
  if (typeof createAgentSession !== "function") {
    throw new SdkNotInstalledError(
      "pi-coding-agent loaded but `createAgentSession` is not a function. " +
        "SDK shape may have changed; rerun `npm run spike` to refresh ~/.pi-comms/sdk-spike.json."
    );
  }
  if (typeof defineTool !== "function") {
    throw new SdkNotInstalledError(
      "pi-coding-agent loaded but `defineTool` is not a function. " +
        "SDK shape may have changed; rerun `npm run spike` to refresh ~/.pi-comms/sdk-spike.json."
    );
  }

  return {
    createAgentSession: createAgentSession as SdkLoaded["createAgentSession"],
    defineTool: defineTool as SdkLoaded["defineTool"],
    raw: mod,
  };
}

// ---------------------------------------------------------------------------
// Public — event mapping (pi-mono AgentSessionEvent → our ChannelEvent)
// ---------------------------------------------------------------------------

/**
 * Map a pi-mono `AgentSessionEvent` (or any of its discriminated variants)
 * into our local `ChannelEvent` so SessionManager can fan-out to channel
 * sinks. Returns `null` when:
 *   - the event isn't a recognized object,
 *   - the event kind is one we don't surface to channels (compaction, retry,
 *     queue updates, internal session bookkeeping, etc.),
 *   - the event is a tool-execution event for one of our OWN tools (tell,
 *     confirm, go_background) — those tools already emit their own events
 *     directly through the sink fan-out and re-emitting via the agent stream
 *     would double-deliver.
 *
 * Mapped kinds:
 *   - `message_end` (assistant turn) → wrap final assistant text into a
 *     synthetic `tell` ChannelEvent so the daemon can deliver it as the
 *     "framework auto-completion" reply (per plan §"Architectural revision
 *     (Option C)" — the framework, not the agent, owns the final reply).
 *   - tool_execution_end / tool_execution_start are NOT mapped to channels
 *     here; SessionManager logs them via the operator logger separately.
 *
 * We intentionally take `unknown` (not the SDK's typed AgentSessionEvent)
 * because:
 *   1. The SDK is an optionalDependency; importing the type at module load
 *      breaks tests on dev machines.
 *   2. Defensive narrowing here also catches future SDK shape drift — if
 *      pi-mono renames `message_end` we'll silently drop it (returning null)
 *      rather than crash the daemon.
 */
export function mapAgentEventToChannelEvent(
  piEvent: unknown,
  options: { now?: () => number } = {}
): ChannelEvent | null {
  if (!piEvent || typeof piEvent !== "object") return null;
  const evt = piEvent as Record<string, unknown>;
  const kind = evt.type;
  if (typeof kind !== "string") return null;

  const now = options.now ?? Date.now;

  // The framework-auto-completion event: pi-mono fires `message_end` with the
  // final assistant message. We surface it as a `tell` urgency=done so the
  // sink fan-out delivers it via channels.
  //
  // NOTE: this is a deliberate UX decision per plan §"Architectural revision
  // (Option C)" — the AGENT does NOT call tell() for completion; we synthesize
  // it here at the event-stream boundary. Agent-discretion `tell()` calls
  // (mid-task interrupts) are emitted directly by the tool, NOT through this
  // mapper.
  if (kind === "message_end") {
    const message = evt.message as Record<string, unknown> | undefined;
    const text = extractAssistantText(message);
    if (!text) return null;
    return {
      type: "tell",
      urgency: "done",
      text,
      ts: now(),
    };
  }

  // All other kinds (turn_start, turn_end, message_update, tool_execution_*,
  // queue_update, compaction_*, auto_retry_*, session_info_changed,
  // thinking_level_changed, agent_start, agent_end) are intentionally NOT
  // mapped to channels. They land in the operator log via SessionManager's
  // own subscriber; the channel layer should not be flooded with stream-level
  // events.
  return null;
}

/**
 * Best-effort extraction of the assistant text from a pi-mono AgentMessage.
 * Pi-mono's message shape is `{ role: 'assistant', content: ContentBlock[] }`
 * where ContentBlock can be text, thinking, tool_call, etc. We concatenate
 * every text block; everything else is ignored.
 */
function extractAssistantText(
  message: Record<string, unknown> | undefined
): string | null {
  if (!message) return null;
  const role = message.role;
  if (role !== "assistant") return null;
  const content = message.content;
  if (typeof content === "string") {
    const t = content.trim();
    return t.length > 0 ? t : null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}
