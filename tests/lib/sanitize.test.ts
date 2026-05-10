/**
 * Unit tests for stripFalseSuccessPrefix — the v0.3.1 F1 defensive helper.
 *
 * Spec: docs/plans/pi_comms_v0_3_1_telegram_polish_and_vllm_optin.plan.md §1.1e
 *
 * The companion regression assertions for formatChannelEvent (telegram +
 * whatsapp) live in tests/telegram-channel.test.ts and
 * tests/whatsapp-channel.test.ts respectively.
 *
 * Coverage matrix:
 *   - Production-format string (the actual gx10 leak shape).
 *   - "pi:" prefix variants (with / without).
 *   - Multi-prefix repetition ({1,10} quantifier exercise).
 *   - Anchor-protection: mid-text ✅ done. is NEVER stripped.
 *   - Empty-input → empty-output (NOT fallback — by design).
 *   - "done." without ✅ → unchanged (no marker, no strip).
 *   - NB-3: leading whitespace before "pi:" (spaces, newlines, combined).
 *   - NB-4: empty post-strip → "pi: ok" fallback (prevents silent drop).
 *   - Case-insensitive matching ("PI:", "DONE").
 */

import { describe, expect, test } from "vitest";
import { stripFalseSuccessPrefix } from "../../src/lib/sanitize.js";

describe("stripFalseSuccessPrefix — F1 defensive strip (v0.3.1)", () => {
  // ---- Production-format string (the actual gx10-831a leak shape) ----
  test("strips the production format 'pi: ✅ done. <text>'", () => {
    const out = stripFalseSuccessPrefix(
      "pi: ✅ done. The sandbox seems to be having issues...",
    );
    expect(out).toBe("The sandbox seems to be having issues...");
  });

  test("strips bare '✅ done. <text>' (no pi: prefix)", () => {
    const out = stripFalseSuccessPrefix("✅ done. text");
    expect(out).toBe("text");
  });

  // ---- Multi-prefix (the {1,10} quantifier) ----
  test("strips multiple stacked prefixes (multi-prefix quantifier)", () => {
    const out = stripFalseSuccessPrefix(
      "pi: ✅ done.\npi: ✅ done. Let me try...",
    );
    expect(out).toBe("Let me try...");
  });

  // ---- Anchor protection ----
  test("does NOT strip mid-text ✅ done. (anchor protection)", () => {
    const input = "Plain reply with ✅ done. embedded mid-text";
    expect(stripFalseSuccessPrefix(input)).toBe(input);
  });

  // ---- Empty input ----
  test("empty input → empty output (NOT fallback by design)", () => {
    expect(stripFalseSuccessPrefix("")).toBe("");
  });

  // ---- 'done.' without the ✅ marker ----
  test("plain 'done.' without ✅ marker is unchanged", () => {
    expect(stripFalseSuccessPrefix("done.")).toBe("done.");
  });

  // ---- NB-3: leading whitespace fixtures ----
  test("NB-3: leading whitespace before 'pi:' is stripped", () => {
    expect(stripFalseSuccessPrefix("  pi: ✅ done. text")).toBe("text");
  });

  test("NB-3: leading newline before 'pi:' is stripped", () => {
    expect(stripFalseSuccessPrefix("\npi: ✅ done. text")).toBe("text");
  });

  test("NB-3: combined leading whitespace + newlines + interior newline", () => {
    expect(stripFalseSuccessPrefix("\n\n  pi: ✅ done.\nfoo")).toBe("foo");
  });

  // ---- NB-4: empty-result fallback ----
  test("NB-4: empty post-strip 'pi: ✅ done.' → 'pi: ok' fallback", () => {
    // Without fallback this would return "" and telegram.ts:518 would
    // silently drop the message — worse UX than the bug being fixed.
    expect(stripFalseSuccessPrefix("pi: ✅ done.")).toBe("pi: ok");
  });

  test("NB-4: empty post-strip '✅ done.' (no pi:) → 'pi: ok' fallback", () => {
    expect(stripFalseSuccessPrefix("✅ done.")).toBe("pi: ok");
  });

  // ---- Case-insensitive ----
  test("case-insensitive: 'PI: ✅ DONE. <text>' is stripped", () => {
    expect(stripFalseSuccessPrefix("PI: ✅ DONE. text")).toBe("text");
  });
});
