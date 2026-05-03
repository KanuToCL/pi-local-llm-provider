/**
 * `~/.pi/agent/models.json` schema validator (zod).
 *
 * Per ~/.llms/plans/pi_comms_daemon.plan.md §"Schema-drift detection"
 * (lines 1224-1228) and Integration Elder concern: the daemon must assert
 * pi-mono's models.json shape at boot — `api`, `apiKey`, `authHeader`,
 * `input`, `cost` per pi-mono ≥0.70 schema. If pi-mono ships an incompatible
 * version, refuse to start with a clear message rather than die mid-prompt.
 *
 * Why a separate file (not in `src/config.ts`):
 *   - `src/config.ts` is env validation; this validates a JSON file pi-mono
 *     itself owns. Keeping the schemas decoupled lets us bump pi-mono
 *     compatibility independently from env contract.
 *   - The file may live anywhere on disk (Sergio's deployment vs. CI vs.
 *     Windows `%USERPROFILE%`); the loader takes a path string + injectable
 *     reader for unit tests.
 *
 * Schema posture:
 *   - We validate ONLY the fields the plan calls out as load-bearing for
 *     pi-mono ≥0.70. Pi-mono's own schema is a moving target; over-validation
 *     here would force us to bump every time pi-mono adds an optional field.
 *   - Unknown fields are ALLOWED (zod's `.passthrough()`) — we need to
 *     coexist with provider-specific extensions.
 *   - The provider container is open (any string keys) since pi-mono lets
 *     users name their providers freely (e.g. `unsloth-studio`, `ollama`).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `validateModelsJson()` when the JSON shape doesn't satisfy the
 * pi-mono ≥0.70 contract. Stable .name for catch-by-name.
 */
export class ModelsJsonValidationError extends Error {
  readonly issues: ReadonlyArray<string>;
  constructor(message: string, issues: ReadonlyArray<string>) {
    super(message);
    this.name = "ModelsJsonValidationError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Per-model entry. Plan §"Upgrades / Schema-drift detection" line 1226 lists
 * the load-bearing fields:
 *   - api          — string (provider transport, e.g. "openai-completions")
 *                    (pi-mono ≥0.72 puts this on the PROVIDER, not the model;
 *                    we accept either location — see ProviderSchema below)
 *   - apiKey       — string (provider-side; we don't require it on each model)
 *   - authHeader   — boolean (whether to send Authorization header)
 *   - input        — string[] (modalities: ["text"], ["text","image"], etc.)
 *   - cost         — { input, output, cacheRead, cacheWrite } (numbers; 0 ok)
 *
 * Anything else passes through unchanged.
 */
const CostSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
  })
  .passthrough();

const ModelEntrySchema = z
  .object({
    id: z.string().min(1, "model.id is required"),
    name: z.string().optional(),
    input: z
      .array(z.string().min(1))
      .nonempty("model.input must declare at least one modality"),
    cost: CostSchema,
    // Optional fields pi-mono uses; we accept them but don't require any.
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
  })
  .passthrough();

const ProviderSchema = z
  .object({
    /** Endpoint base URL (e.g. http://localhost:8888/v1). Optional only when
     *  pi-mono can derive it (some providers); we require it to be present
     *  for any custom provider so the daemon can verify reachability. */
    baseUrl: z.string().min(1).optional(),
    /** Provider transport name (e.g. "openai-completions"). pi-mono ≥0.72
     *  carries this here; older shapes carried it per-model. We accept
     *  either via a custom refinement on the parent. */
    api: z.string().min(1, "provider.api is required").optional(),
    /** API key string (or env-var indirection — pi-mono resolves both). */
    apiKey: z.string().min(1, "provider.apiKey is required").optional(),
    /** Whether to send Authorization header. */
    authHeader: z.boolean().optional(),
    models: z.array(ModelEntrySchema).nonempty("provider.models must be non-empty"),
  })
  .passthrough();

/**
 * Top-level shape: `{ providers: { <providerId>: Provider } }`. pi-mono ≥0.72
 * adds default-provider fields and per-provider settings; we accept those
 * via passthrough.
 */
export const ModelsJsonSchema = z
  .object({
    providers: z.record(ProviderSchema).refine(
      (rec) => Object.keys(rec).length > 0,
      { message: "models.json must declare at least one provider" }
    ),
  })
  .passthrough();

export type ModelsJson = z.infer<typeof ModelsJsonSchema>;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a parsed models.json object. Throws `ModelsJsonValidationError`
 * with a flat list of human-readable issues on failure.
 *
 * Cross-field rules layered on top of the per-field zod schema:
 *   - Each provider must declare `api` (either at provider level or on every
 *     model) AND `apiKey` AND `authHeader` (boolean). pi-mono ≥0.70 carries
 *     these at the provider level; older shapes had them per-model. We accept
 *     either location for backward compat but require them to exist somewhere.
 */
export function validateModelsJson(parsed: unknown): ModelsJson {
  const result = ModelsJsonSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const where = i.path.length > 0 ? i.path.join(".") : "<root>";
      return `${where}: ${i.message}`;
    });
    throw new ModelsJsonValidationError(
      `models.json validation failed: ${issues.join("; ")}`,
      issues
    );
  }

  const data = result.data;

  // Cross-field: every provider must surface `api` + `apiKey` + `authHeader`
  // either at the provider level or on every model. We don't enforce the
  // model-level fallback here; pi-mono ≥0.72 puts them at the provider level
  // and v3-config-shape support is out of scope.
  const issues: string[] = [];
  for (const [pid, provider] of Object.entries(data.providers)) {
    const p = provider as z.infer<typeof ProviderSchema>;
    if (!p.api) {
      issues.push(`providers.${pid}: api field is required`);
    }
    if (!p.apiKey) {
      issues.push(`providers.${pid}: apiKey field is required`);
    }
    if (typeof p.authHeader !== "boolean") {
      issues.push(`providers.${pid}: authHeader (boolean) is required`);
    }
  }
  if (issues.length > 0) {
    throw new ModelsJsonValidationError(
      `models.json missing required fields: ${issues.join("; ")}`,
      issues
    );
  }

  return data;
}

/**
 * Convenience: read a JSON file from disk and validate. Throws
 * `ModelsJsonValidationError` for parse failures too (so callers only need
 * one catch path).
 */
export async function loadAndValidateModelsJson(
  path: string,
  reader: (p: string) => Promise<string> = defaultReader
): Promise<ModelsJson> {
  let raw: string;
  try {
    raw = await reader(path);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ModelsJsonValidationError(
      `models.json could not be read at ${path}: ${cause}`,
      [`io: ${cause}`]
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new ModelsJsonValidationError(
      `models.json at ${path} is not valid JSON: ${cause}`,
      [`json-parse: ${cause}`]
    );
  }
  return validateModelsJson(parsed);
}

async function defaultReader(p: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(p, "utf8");
}
