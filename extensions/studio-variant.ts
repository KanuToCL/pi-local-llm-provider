/**
 * pi-mono extension: /studio-variant
 *
 * Inside a pi session, prints the GGUF variant Unsloth Studio currently has
 * loaded (Q3_K_M, UD-Q4_K_XL, …). pi sees only the OpenAI base id, so
 * variant choice is otherwise invisible — and it directly affects tool-call
 * fidelity (Q2/Q3 silently drop required args).
 *
 * Install: copy to ~/.pi/agent/extensions/studio-variant.ts (auto-discovered),
 *          or pass `pi -e ./extensions/studio-variant.ts` for one-off testing.
 *
 * Env:  STUDIO_BASE_URL (default http://localhost:8888)
 *       UNSLOTH_API_KEY (required — same key pi uses for the provider)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("studio-variant", {
    description: "Show the GGUF variant Unsloth Studio currently has loaded",
    handler: async (_args, ctx) => {
      const base = (process.env.STUDIO_BASE_URL || "http://localhost:8888").replace(/\/+$/, "");
      const key = process.env.UNSLOTH_API_KEY;
      if (!key) {
        ctx.ui.notify("UNSLOTH_API_KEY not set in env", "error");
        return;
      }

      let resp: Response;
      try {
        resp = await fetch(`${base}/api/inference/status`, {
          headers: { Authorization: `Bearer ${key}` },
        });
      } catch (err) {
        ctx.ui.notify(`Studio unreachable at ${base}: ${(err as Error).message}`, "error");
        return;
      }
      if (!resp.ok) {
        ctx.ui.notify(`Studio HTTP ${resp.status} ${resp.statusText}`, "error");
        return;
      }

      const s = (await resp.json()) as {
        active_model?: string;
        gguf_variant?: string;
        is_gguf?: boolean;
        supports_reasoning?: boolean;
        loaded?: string[];
        loading?: string[];
      };

      const variant = s.gguf_variant ?? "(n/a)";
      const summary = `${s.active_model ?? "(none)"} · variant=${variant} · reasoning=${s.supports_reasoning ?? false}`;

      const isAggressiveQuant = /^Q[23](_|$)/i.test(variant);
      ctx.ui.notify(summary, isAggressiveQuant ? "warning" : "info");

      if (isAggressiveQuant) {
        ctx.ui.notify(
          `${variant} drops tool-call args on multi-arg tools (e.g. edit). Prefer Q4_K_M / UD-Q4_K_XL or higher.`,
          "warning",
        );
      }
    },
  });
}
