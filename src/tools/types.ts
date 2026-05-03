/**
 * Shared tool-side types.
 *
 * Ownership note (W2 IMPL-8):
 *   - The `Sink` interface here is a PLACEHOLDER. IMPL-12 (W3) will own the
 *     canonical `src/channels/base.ts` and the same shape will live there.
 *     When that lands, this file should re-export the channel-side type
 *     instead of declaring it locally.  For now we declare it here so
 *     tools/tell, tools/confirm, tools/go-background can compile in W2 BEFORE
 *     W3 has landed.  See plan §"Implementation: the daemon has a `Sink`
 *     interface per attached client."
 *
 *   - `ChannelEvent` is the discriminated union of everything tools can
 *     emit through a sink.  IMPL-12 will receive it and route it to the
 *     concrete transport (terminal stdout, WhatsApp DM, Telegram bot).
 *     Per plan §"v4.3 simplified tell()", §"v4.2 confirm() semantics",
 *     §"Phase 1.5 — Single In-Flight Task".
 *
 *   - `ToolContext` is a TODO stub.  Pi-mono's actual extension SDK passes a
 *     much richer `ExtensionContext` object to tool `execute()` handlers
 *     (see `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`
 *     `ExtensionContext`).  Our tools don't need most of it; we only care about
 *     `signal` (AbortSignal) and a small subset.  Once IMPL-13 (W3+) lands the
 *     daemon glue we'll narrow this to whatever is actually load-bearing.
 *     For now the tools accept the SDK-provided ctx as `unknown` and ignore
 *     it; the registries/state are passed in through a closure at definition
 *     time, NOT through ctx.
 */

// ---------------------------------------------------------------------------
// Public — tool-emitted-event vocabulary
// ---------------------------------------------------------------------------

export type ToolUrgency = "info" | "milestone" | "done" | "blocked" | "question";

/**
 * A side-channel event a tool wants emitted to one or more sinks.
 *
 * Tools NEVER write directly to a channel; they hand a `ChannelEvent` to a
 * `Sink` and the sink owns transport.  This keeps the destructive-command
 * sandbox + redaction logic in one place (the channel layer) instead of
 * every tool needing to know about credential-shape regex etc.
 *
 * Plan §"Sink interface stays simple": WhatsApp sink receives tell + confirm
 * + go-background notice; terminal sink receives all events.
 */
export type ChannelEvent =
  | {
      type: "tell";
      urgency: ToolUrgency;
      text: string;
      ts: number;
    }
  | {
      type: "confirm_request";
      shortId: string;
      question: string;
      rationale: string;
      risk: string;
      expiresAt: number;
      ts: number;
    }
  | {
      type: "auto_promote_notice";
      firingNumber: number;
      taskAgeSeconds: number;
      ts: number;
    }
  | {
      type: "go_background_notice";
      userMessagePreview: string;
      ts: number;
    };

// ---------------------------------------------------------------------------
// Public — Sink interface (PLACEHOLDER; IMPL-12 W3 owns the canonical home)
// ---------------------------------------------------------------------------

/**
 * One sink per attached client.
 *
 * TODO(IMPL-12, W3): when `src/channels/base.ts` lands, IMPL-12 should:
 *   1. define the canonical `Sink` interface in `src/channels/base.ts`
 *   2. have it match this exact shape (or a strict superset)
 *   3. re-export from this module so callers can keep
 *      `import { Sink } from "../tools/types.js"` working.
 *
 * Send semantics:
 *   - Each call MUST be best-effort. If the underlying transport is dead
 *     (WhatsApp re-pair needed, terminal client disconnected, etc.) the sink
 *     should resolve (not reject) and the failure is observable via channel
 *     state, NOT via this method's return value.  Tools fan out to multiple
 *     sinks in parallel and a single sink failing must not block the others.
 *   - Sinks SHOULD be idempotent w.r.t. duplicate event ids when they have
 *     them; tools do not pre-dedup at the sink layer.
 */
export interface Sink {
  send(event: ChannelEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public — ToolContext (TODO stub for what pi-mono actually passes)
// ---------------------------------------------------------------------------

/**
 * What pi-mono's `defineTool({ execute })` callback actually receives at
 * runtime is a rich `ExtensionContext` (see pi-coding-agent
 * `dist/core/extensions/types.d.ts:207`).  Most fields don't matter to our
 * tools because all the load-bearing state — sinks, pending-confirms,
 * task-state — is captured at tool-definition time via closure, NOT looked
 * up off the per-call ctx.
 *
 * TODO(IMPL-13, W3+): once the daemon glue lands, narrow this to ONLY the
 * fields tools care about (likely just `signal: AbortSignal | undefined`)
 * and adapt the SDK-provided ctx through that.
 *
 * For now we type the per-call ctx as `unknown` so the tool definitions
 * compile against any pi-mono SDK shape, with no runtime dependency on
 * pi-mono being installed (W1 spike: pi-mono is in `optionalDependencies`
 * and may be missing on dev machines).
 */
export type ToolContext = unknown;

// ---------------------------------------------------------------------------
// Public — minimal ToolDefinition shape (compile-time-only)
// ---------------------------------------------------------------------------

/**
 * A pi-mono-`defineTool`-compatible shape we can construct WITHOUT importing
 * the SDK at module-evaluation time.
 *
 * Why a hand-rolled shape instead of `import type { ToolDefinition } from
 * "@mariozechner/pi-coding-agent"`?
 *   - pi-mono is in `optionalDependencies`. If it's not installed, the
 *     `import type` still succeeds (TS treats absent type-only imports as
 *     `any` with `skipLibCheck`), but on machines WHERE it IS installed
 *     `ToolDefinition.execute` requires a TypeBox `TSchema` and a specific
 *     5-arg signature `(toolCallId, params, signal, onUpdate, ctx)`.
 *   - Our tests would then need TypeBox, which would force a hard dep.
 *   - The pi-mono SDK is duck-typed at registration time (it just calls
 *     `execute(...)` with whatever args), so a structurally-compatible
 *     shape works fine for the daemon AND the tests can construct tools
 *     without dragging in TypeBox.
 *
 * TODO(IMPL-13, W3+): once the daemon glue lands and we know the SDK is
 * installed in production, this can be replaced with a thin alias:
 *   `export type ToolDefinition = import("@mariozechner/pi-coding-agent").ToolDefinition;`
 * and the tool factories below cast to that on the way out.
 */
export interface DefinedTool {
  name: string;
  description: string;
  /** JSON-Schema-shaped object.  pi-mono accepts TypeBox TSchema, which is a
   *  superset of JSON Schema.  We declare the minimum tools need and let the
   *  SDK validate at registration time. */
  parameters: Record<string, unknown>;
  /**
   * Execute the tool.  Arguments mirror pi-mono's `execute()` signature
   * loosely: the SDK will pass (toolCallId, params, signal, onUpdate, ctx);
   * our handlers only care about `params` and the captured-via-closure
   * registries, so extra positional args are tolerated.
   */
  execute: (
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ) => Promise<unknown>;
}

/**
 * Sink fan-out helper.  Used by every tool that emits a ChannelEvent.
 * Calls `send()` on each defined sink in parallel; collects which ones
 * succeeded.  A sink that throws is logged via `errors[]` and counts as
 * NOT delivered, but does not abort the fan-out.
 *
 * Returns the names of sinks that resolved successfully so the tool can
 * surface them to the agent (handy for "deliveredTo: ['terminal','whatsapp']").
 */
/**
 * Sink-bag type: a plain object whose values are `Sink | undefined`.  We
 * accept ANY object shape with sink-like values; the field names become the
 * `deliveredTo[]` strings returned to the agent.  Specific tools narrow this
 * via their own typed interfaces (e.g. TellSinks { whatsapp?, terminal?, ... })
 * which, because they use the `?:` modifier, are structurally compatible
 * with this loose shape.
 */
export type SinkBag = Readonly<Record<string, Sink | undefined>>;

export async function fanOut(
  sinks: SinkBag,
  event: ChannelEvent,
): Promise<{ deliveredTo: string[]; errors: { sink: string; error: Error }[] }> {
  const entries = Object.entries(sinks).filter(
    (entry): entry is [string, Sink] => entry[1] !== undefined,
  );
  const settled = await Promise.allSettled(
    entries.map(async ([_name, sink]) => sink.send(event)),
  );
  const deliveredTo: string[] = [];
  const errors: { sink: string; error: Error }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const [name] = entries[i]!;
    const r = settled[i]!;
    if (r.status === "fulfilled") {
      deliveredTo.push(name);
    } else {
      const err =
        r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      errors.push({ sink: name, error: err });
    }
  }
  return { deliveredTo, errors };
}
