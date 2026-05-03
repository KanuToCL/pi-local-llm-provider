/**
 * Single-key serial queue for global GPU-bound operations.
 *
 * Lifted (verbatim shape) from gemini-claw `src/assistant/chatQueue.ts:1-28`,
 * renamed `ChatOperationQueue` → `GlobalQueue`. The original was a per-chat
 * mutex; we collapse to a single key (`'global'`) because we have one GPU
 * and inference must be serialized across all channels.
 *
 * Pattern: each new operation chains onto the prior promise via
 * `previous.catch(() => undefined).then(() => current)` so an error in op N
 * does NOT poison op N+1's await. The queue map entry is cleaned up only
 * if the current entry is still the one we wrote (CAS-style guard).
 *
 * Per plan §"Lift wholesale" row "Per-key serial queue".
 */

export interface ChatOperationRunner {
  run<T>(chatId: string, operation: () => Promise<T>): Promise<T>;
}

export class GlobalQueue implements ChatOperationRunner {
  private readonly chatQueues = new Map<string, Promise<void>>();

  async run<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);

    this.chatQueues.set(chatId, queued);
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.chatQueues.get(chatId) === queued) {
        this.chatQueues.delete(chatId);
      }
    }
  }
}
