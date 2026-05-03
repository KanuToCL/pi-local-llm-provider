/**
 * AST-pass tests for the destructive-command classifier.
 *
 * These exercise the bash AST decomposition: pipelines, sequences, logical
 * operators, subshells, command substitution. The classifier must escalate
 * when ANY atomic sub-command is critical/high.
 */

import { describe, expect, test } from "vitest";
import { classify } from "../src/guards/classifier.js";
import { flattenCommand } from "../src/guards/ast-bash.js";

describe("AST flattening", () => {
  test("returns single atom for a single command", () => {
    expect(flattenCommand("git status")).toEqual(["git status"]);
  });

  test("splits on ; sequences", () => {
    expect(flattenCommand("a ; b ; c")).toEqual(["a", "b", "c"]);
  });

  test("splits on && and ||", () => {
    expect(flattenCommand("a && b || c")).toEqual(["a", "b", "c"]);
  });

  test("splits on |", () => {
    expect(flattenCommand("a | b | c")).toEqual(["a", "b", "c"]);
  });

  test("recurses into ( ... ) subshell", () => {
    expect(flattenCommand("(cd /tmp && rm -rf foo)")).toEqual([
      "cd /tmp",
      "rm -rf foo",
    ]);
  });

  test("recurses into $( ... ) command substitution", () => {
    expect(flattenCommand("echo $(id)")).toEqual(["echo", "id"]);
  });

  test("recurses into backtick command substitution", () => {
    expect(flattenCommand("echo `id`")).toEqual(["echo", "id"]);
  });

  test("does NOT split inside single-quoted strings", () => {
    expect(flattenCommand("echo 'a; b && c'")).toEqual(["echo 'a; b && c'"]);
  });

  test("does NOT split inside double-quoted strings", () => {
    expect(flattenCommand('echo "a; b && c"')).toEqual(['echo "a; b && c"']);
  });
});

describe("classify with AST escalation", () => {
  test("git status && rm -rf / → blocked-equivalent (confirm) due to fs-wipe", () => {
    const r = classify("git status && rm -rf /");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
    // layered findings should include the rm match
    expect(r.layeredFindings).toBeDefined();
    expect(
      (r.layeredFindings ?? []).some((f) =>
        (f.matchedRule ?? "").includes("fs-wipe"),
      ),
    ).toBe(true);
  });

  test("(cd /tmp && rm -rf $HOME) → confirm (path-relative trips inside subshell)", () => {
    const r = classify("(cd /tmp && rm -rf $HOME)");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("echo hi | rm -rf / → confirm (right-side of pipe trips fs-wipe)", () => {
    const r = classify("echo hi | rm -rf /");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("git status; ls; rm -rf / → confirm (third leg trips)", () => {
    const r = classify("git status; ls; rm -rf /");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("git status; ls; echo bye → allow (no destructive atom)", () => {
    const r = classify("git status; ls; echo bye");
    expect(r.decision).toBe("allow");
  });

  test("git status (single) → allow", () => {
    const r = classify("git status");
    expect(r.decision).toBe("allow");
    expect(r.layeredFindings).toBeUndefined();
  });

  test("nested subshell: (cd / && (rm -rf etc)) → confirm", () => {
    const r = classify("(cd / && (rm -rf /etc))");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("$(rm -rf /) command substitution → confirm", () => {
    const r = classify("echo $(rm -rf /)");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("backtick `rm -rf /` → confirm", () => {
    const r = classify("echo `rm -rf /`");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("background fork (sudo apt update &) → confirm", () => {
    const r = classify("sudo apt update &");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("OR fallback: ls /nonexistent || rm -rf / → confirm", () => {
    const r = classify("ls /nonexistent || rm -rf /");
    expect(r.decision).toBe("confirm");
    expect(r.severity).toBe("critical");
  });

  test("layered findings preserved for forensic logging", () => {
    const r = classify("rm -rf / ; aws s3 delete s3://x/y");
    expect(r.decision).toBe("confirm");
    expect(r.layeredFindings).toBeDefined();
    expect((r.layeredFindings ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
