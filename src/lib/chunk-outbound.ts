/**
 * Outbound message chunking — splits long text into channel-bounded pieces.
 *
 * Lifted (verbatim shape) from gemini-claw `src/bot/messageUtils.ts:1-36`
 * (chunkTelegramMessage + findSplitPoint). MIT-licensed; see Acknowledgements.
 *
 * Strategy (in order):
 *   1. Prefer a newline split if it lands past 60% of `maxLength`
 *   2. Otherwise prefer a space split if it lands past 60% of `maxLength`
 *   3. Otherwise hard-cut at `maxLength`
 *
 * The 60% threshold prevents pathological tiny chunks when a long line/word
 * happens early in the buffer.
 *
 * Used for both Telegram (4096-char limit) and WhatsApp (~65k but Baileys
 * recommends smaller). Per plan §"Lift wholesale" row "Outbound chunking".
 */

export function chunkOutbound(text: string, maxLength: number): string[] {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    throw new Error(
      `chunkOutbound: maxLength must be a positive finite number, got ${maxLength}`,
    );
  }

  const normalized = text.trim();

  if (!normalized) {
    return ["I did not receive a response."];
  }

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const splitAt = findSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitPoint(text: string, maxLength: number): number {
  const newline = text.lastIndexOf("\n", maxLength);
  if (newline > maxLength * 0.6) return newline;

  const space = text.lastIndexOf(" ", maxLength);
  if (space > maxLength * 0.6) return space;

  return maxLength;
}
