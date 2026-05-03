/**
 * Destructive-command classifier — orchestrates regex rules + AST decomposition.
 *
 * REMINDER (per plan v4.2): the classifier is a TRIPWIRE for the obviously-
 * careless agent, NOT a security control. The OS-level sandbox in
 * src/sandbox/* is what actually prevents damage.
 *
 * Pipeline:
 *   1. Run every Rule.pattern against the full command string. Track strictest
 *      matching decision.
 *   2. Decompose via flattenCommand() and recurse classify() on each atom.
 *   3. If ANY sub-command is critical/high, escalate the overall decision.
 *   4. Collect layered findings for forensic logging.
 */

import { flattenCommand } from "./ast-bash.js";
import {
  DECISION_ORDER,
  Decision,
  Rule,
  RULES,
  SEVERITY_ORDER,
  Severity,
} from "./rules.js";

export interface ClassifyResult {
  decision: Decision;
  severity?: Severity;
  matchedRule?: string; // rule id
  reason?: string;
  layeredFindings?: ClassifyResult[]; // for AST sub-results
}

/** Strictest decision wins; ties broken by severity. */
function stricter(a: ClassifyResult, b: ClassifyResult): ClassifyResult {
  const da = DECISION_ORDER[a.decision];
  const db = DECISION_ORDER[b.decision];
  if (db > da) return b;
  if (da > db) return a;
  // Equal decision — prefer the one with higher severity (or any if neither).
  const sa = a.severity ? SEVERITY_ORDER[a.severity] : -1;
  const sb = b.severity ? SEVERITY_ORDER[b.severity] : -1;
  return sb > sa ? b : a;
}

/** Run every regex rule against `cmd`; return the strictest match (or allow). */
function regexPass(cmd: string): ClassifyResult {
  let best: ClassifyResult = { decision: "allow" };
  for (const rule of RULES as readonly Rule[]) {
    if (rule.pattern.test(cmd)) {
      const candidate: ClassifyResult = {
        decision: rule.decision,
        severity: rule.severity,
        matchedRule: rule.id,
        reason: rule.description,
      };
      best = stricter(best, candidate);
    }
  }
  return best;
}

/**
 * Classify a command string.
 *
 * Always returns a ClassifyResult — never throws on malformed input.
 * `layeredFindings` is populated only when AST decomposition produced
 * sub-commands that themselves matched non-trivially.
 */
export function classify(cmd: string): ClassifyResult {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return { decision: "allow" };

  // --- Pass 1: full-string regex ---
  const fullPass = regexPass(trimmed);

  // --- Pass 2: AST decomposition ---
  const atoms = flattenCommand(trimmed);
  // If decomposition produced exactly the input itself (single atomic command),
  // skip recursion — fullPass already handled it.
  const isSingleAtom = atoms.length === 1 && atoms[0] === trimmed;

  let layered: ClassifyResult[] | undefined;
  let combined = fullPass;

  if (!isSingleAtom) {
    layered = [];
    for (const atom of atoms) {
      // Recurse — sub-commands may themselves have pipelines (subshell groups).
      const sub = classify(atom);
      // Only retain findings that flagged something — keep the audit log lean.
      if (sub.decision !== "allow" || sub.matchedRule) {
        layered.push(sub);
      }
      combined = stricter(combined, sub);
    }
    if (layered.length === 0) layered = undefined;
  }

  if (layered !== undefined) {
    return { ...combined, layeredFindings: layered };
  }
  return combined;
}
