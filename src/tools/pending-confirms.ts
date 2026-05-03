/**
 * Awaitable confirm-flow registry for the `confirm()` tool.
 *
 * Per `~/.llms/plans/pi_comms_daemon.plan.md`:
 *   - §"v4.2 confirm() semantics fully specified" (lines 1116-1141): the
 *     full spec for IDs, multiplicity, timeout, late-reply, and per-task
 *     cap. This module owns the in-memory promise-resolution registry;
 *     `src/tools/confirm.ts` (IMPL-8) wraps `create()` and exposes the
 *     awaitable to pi-mono.
 *   - Pitfall #25 (line 1265): late `/confirm A7K9 yes` past timeout
 *     gets an explicit "your reply arrived after timeout" message. This
 *     module surfaces the timeout via `expire()`; the message itself is
 *     emitted by the channel command handler.
 *   - Pitfall #26 (line 1266): max 3 pending per task; the cap itself
 *     is enforced by `confirm.ts` at request time, not here. We provide
 *     `list(taskId)` so the caller can count.
 *
 * Design notes:
 *   - 4-char IDs from a confusion-free 31-char alphabet (no 0/O/1/I/L)
 *     give ~923K id-space. We re-roll on collision against the
 *     CURRENTLY-PENDING set (resolved+removed entries free up their id
 *     for reuse), capped at 100 retries.
 *   - The promise-resolution model: `create()` returns both the id (for
 *     surfacing in the user-visible question) and the promise (for the
 *     agent to await). The promise resolves to `true` on yes, `false`
 *     on no, expired-via-`expire()`, or `clear()`-cleanup.
 *   - The registry is in-memory only. Confirms do NOT survive a daemon
 *     restart; the agent will see its `await` reject (or never resolve)
 *     and the recovery flow from `task-state.ts` handles the user-side
 *     re-prompt. v5 backlog item if we need cross-restart confirms.
 */

/**
 * Confusion-safe alphabet. Drops the 5 ambiguous-on-small-screen glyphs
 * the brief calls out: `0` / `O`, `1` / `I` / `L`. Crockford base32
 * canonically drops `I L O U`; we additionally drop `0` and `1` and keep
 * `U` for a 31-char alphabet. Exported so tests verify the exact set.
 *
 * We don't actually base32-encode bytes — we just pick characters
 * uniformly at random. 31 chars × 4 positions = 923,521 id-space, which
 * is plenty given the per-task cap of 3 pending confirms.
 */
export const ALLOWED_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" as const;
const ID_ALPHABET = ALLOWED_ID_ALPHABET;

const ID_LENGTH = 4;
const MAX_COLLISION_RETRIES = 100;
const DEFAULT_TTL_MS = 30 * 60 * 1_000; // 30 minutes per plan line 1126

/**
 * The set of channels a confirm can originate from. Mirrors
 * `src/lib/task-state.ts:ChannelId` — kept inline here to avoid a
 * cross-module type cycle.
 */
export type ChannelId = "terminal" | "whatsapp" | "telegram";

/** A pending confirm awaiting user resolution. */
export interface PendingConfirm {
  /** 4-char id from ALLOWED_ID_ALPHABET. */
  shortId: string;
  taskId: string;
  question: string;
  rationale: string;
  risk: string;
  /** Unix epoch ms after which the entry is considered expired. */
  expiresAt: number;
  channel: ChannelId;
}

interface RegistryEntry extends PendingConfirm {
  resolve: (decision: boolean) => void;
  /** Monotonic creation index for "most recent" lookup. */
  createdSeq: number;
}

export interface CreateOpts {
  taskId: string;
  question: string;
  rationale: string;
  risk: string;
  channel: ChannelId;
  /** Time-to-live in ms; defaults to 30 min per plan. */
  ttlMs?: number;
}

export interface CreateResult {
  /** The 4-char id surfaced to the user (e.g. "A7K9"). */
  id: string;
  /** Resolves true=yes, false=no/timeout/clear. */
  promise: Promise<boolean>;
}

export interface ResolveMostRecentResult {
  resolved: boolean;
  /** True when 2+ entries are pending and the caller must disambiguate. */
  ambiguous: boolean;
}

export interface PendingConfirmsRegistryOpts {
  /**
   * RNG returning a value in [0, 1). Defaults to `Math.random`. Tests
   * inject a seeded sequence to verify collision-retry behavior.
   */
  rng?: () => number;
  /**
   * Clock for `expiresAt` calculations. Defaults to `Date.now`. Tests
   * may override to make TTL math deterministic without `vi.useFakeTimers`.
   */
  now?: () => number;
}

export class PendingConfirmsRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  /**
   * IDs of entries that were resolved via `expire(now)`.  Consumed by
   * `consumeTimedOut(shortId)` so the confirm adapter (src/session.ts)
   * can distinguish "user-no" (false via resolve()) from "timeout"
   * (false via expire()).  Entries are added on expire and removed on
   * read — one-shot semantics.
   */
  private readonly recentlyTimedOut = new Set<string>();
  private readonly rng: () => number;
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: PendingConfirmsRegistryOpts = {}) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Register a new pending confirm. Returns an id (for the user-visible
   * question) and a promise the agent awaits for the decision.
   */
  create(opts: CreateOpts): CreateResult {
    const id = this.generateUniqueId();
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const expiresAt = this.now() + ttlMs;

    let resolveFn!: (decision: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
    });

    this.seq += 1;
    const entry: RegistryEntry = {
      shortId: id,
      taskId: opts.taskId,
      question: opts.question,
      rationale: opts.rationale,
      risk: opts.risk,
      channel: opts.channel,
      expiresAt,
      resolve: resolveFn,
      createdSeq: this.seq,
    };
    this.entries.set(id, entry);
    return { id, promise };
  }

  /**
   * Resolve a confirm by exact id. Returns true if found+resolved,
   * false if the id is unknown or already resolved.
   */
  resolve(shortId: string, decision: "yes" | "no"): boolean {
    const entry = this.entries.get(shortId);
    if (!entry) return false;
    this.entries.delete(shortId);
    entry.resolve(decision === "yes");
    return true;
  }

  /**
   * Resolve "the" pending confirm when there is exactly one. Returns
   * `{ ambiguous: true }` (without resolving) when 2+ are pending, so
   * the channel handler can ask the user to disambiguate. Returns
   * `{ resolved: false, ambiguous: false }` when nothing is pending.
   */
  resolveMostRecent(decision: "yes" | "no"): ResolveMostRecentResult {
    const all = [...this.entries.values()];
    if (all.length === 0) return { resolved: false, ambiguous: false };
    if (all.length >= 2) return { resolved: false, ambiguous: true };
    const only = all[0];
    this.entries.delete(only.shortId);
    only.resolve(decision === "yes");
    return { resolved: true, ambiguous: false };
  }

  /**
   * Snapshot of pending entries. When `filterTaskId` is given, only
   * entries for that task are returned (used to enforce the per-task
   * cap of 3 from `src/tools/confirm.ts`).
   *
   * Returns `PendingConfirm[]` (without the internal `resolve` fn or
   * sequence number) — the public shape only.
   */
  list(filterTaskId?: string): readonly PendingConfirm[] {
    const out: PendingConfirm[] = [];
    for (const e of this.entries.values()) {
      if (filterTaskId && e.taskId !== filterTaskId) continue;
      out.push({
        shortId: e.shortId,
        taskId: e.taskId,
        question: e.question,
        rationale: e.rationale,
        risk: e.risk,
        expiresAt: e.expiresAt,
        channel: e.channel,
      });
    }
    return out;
  }

  /**
   * Expire entries whose `expiresAt < now`. Returns the expired entries
   * (so the caller can emit `confirm_timed_out` audit events and the
   * pitfall-#25 user-visible "your reply arrived after timeout" reply,
   * which actually goes the OTHER way — see Pitfall #25 in plan).
   *
   * Each expired promise resolves to `false` (default-deny on timeout
   * per plan line 1131: "that operation was already declined").
   *
   * AUDIT-C #10: tag each expired shortId in `recentlyTimedOut` so the
   * confirm adapter (src/session.ts) can distinguish "user-no" (false
   * via resolve()) from "timeout" (false via expire()) when the boolean
   * resolution otherwise loses the distinction.  Entries linger in the
   * set until `consumeTimedOut(shortId)` is called by the adapter (which
   * happens immediately after the awaited promise settles).
   */
  expire(now: number): readonly PendingConfirm[] {
    const expired: PendingConfirm[] = [];
    for (const e of [...this.entries.values()]) {
      if (e.expiresAt < now) {
        this.entries.delete(e.shortId);
        this.recentlyTimedOut.add(e.shortId);
        e.resolve(false);
        expired.push({
          shortId: e.shortId,
          taskId: e.taskId,
          question: e.question,
          rationale: e.rationale,
          risk: e.risk,
          expiresAt: e.expiresAt,
          channel: e.channel,
        });
      }
    }
    return expired;
  }

  /**
   * AUDIT-C #10: was `shortId` resolved via timeout (vs user-no)?  Removes
   * the entry from the recently-timed-out set on read so the second call
   * with the same id returns false (one-shot semantics).
   */
  consumeTimedOut(shortId: string): boolean {
    return this.recentlyTimedOut.delete(shortId);
  }

  /**
   * Resolve every pending entry to `false` and empty the registry.
   * Used at task cancellation / daemon shutdown so the agent's awaits
   * unblock immediately rather than dangling.
   */
  clear(): void {
    for (const e of this.entries.values()) {
      e.resolve(false);
    }
    this.entries.clear();
  }

  /**
   * Generate a 4-char id from ID_ALPHABET that does not collide with
   * any currently-pending entry. Throws after MAX_COLLISION_RETRIES
   * exhausted attempts — by then the caller is either in an infinite
   * loop bug or has somehow accumulated ~31^4 pending confirms (which
   * the per-task cap of 3 makes impossible in practice).
   */
  private generateUniqueId(): string {
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
      let id = "";
      for (let i = 0; i < ID_LENGTH; i += 1) {
        const r = this.rng();
        // Clamp into [0, alphabet.length-1].
        const idx = Math.min(
          ID_ALPHABET.length - 1,
          Math.max(0, Math.floor(r * ID_ALPHABET.length))
        );
        id += ID_ALPHABET[idx];
      }
      if (!this.entries.has(id)) return id;
    }
    throw new Error(
      `pending-confirms: no unique id available after ${MAX_COLLISION_RETRIES} retries (collision-retry exhausted)`
    );
  }
}
