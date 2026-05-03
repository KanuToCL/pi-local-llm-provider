/**
 * Minimal bash AST — flattens a command string into atomic sub-commands.
 *
 * KNOWN LIMITATIONS (deliberate; this is a tripwire, NOT a security control —
 * see SECURITY.md and tests/classifier-known-limitations.test.ts):
 *   1. No full POSIX shell support. We only handle the operators most commonly
 *      used by careless agents: pipes, sequences, &&/||, subshells, $(),
 *      backticks. We do NOT implement: process substitution `<()`, here-docs,
 *      brace expansion, parameter expansion that produces commands, full
 *      quoting semantics (only top-level quote-balance), redirection parsing.
 *   2. Runtime construction (`eval`, `bash -c`, `python -c`, base64-decode-eval)
 *      defeats all static analysis. The classifier flags `eval` and `*-c` as
 *      CRITICAL precisely because their argument is opaque.
 *   3. No real lexer. We tokenize char-by-char with a simple quote-aware
 *      walker. Edge cases (e.g. backslash-escaped operators) may split
 *      incorrectly. That is acceptable for a tripwire.
 *
 * Total LOC budget per IMPL-10 spec: ~150 lines.
 */

/**
 * Tokenize the input into operator boundaries while respecting:
 *   - single-quoted strings (cannot contain escapes; nothing terminates but ')
 *   - double-quoted strings (backslash-escapes; nothing terminates but ")
 *   - backslash-escapes outside quotes
 *   - balanced parens for subshells `( ... )` and `$( ... )`
 *   - balanced backticks ` ... `
 *
 * Operators we split on: `|` `||` `&&` `;` `&` (background)
 * — but NOT inside quotes/parens/backticks.
 *
 * Subshell groups `( ... )` and command-substitutions `$( ... )` and backtick
 * spans are returned as a single "group" token; we recurse into them after
 * stripping the wrapper.
 */
type Tok = { kind: "cmd" | "group" | "sep"; text: string };

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let buf = "";
  const flushCmd = (): void => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) toks.push({ kind: "cmd", text: trimmed });
    buf = "";
  };
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    // --- Quoted strings: copy verbatim into buf, skip operator scan inside ---
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? n : end + 1;
      buf += input.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (input[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (input[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      buf += input.slice(i, j);
      i = j;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      buf += input.slice(i, i + 2);
      i += 2;
      continue;
    }
    // --- Backtick command substitution ---
    if (c === "`") {
      const end = input.indexOf("`", i + 1);
      const stop = end === -1 ? n : end;
      // Stash any pending plain command, then emit the substitution group.
      flushCmd();
      toks.push({ kind: "group", text: input.slice(i + 1, stop) });
      i = stop + 1;
      continue;
    }
    // --- Subshell group ( ... )  or  $( ... ) ---
    if (c === "(" || (c === "$" && input[i + 1] === "(")) {
      const startInner = c === "(" ? i + 1 : i + 2;
      let depth = 1;
      let j = startInner;
      while (j < n && depth > 0) {
        const cc = input[j];
        if (cc === "'") {
          const e = input.indexOf("'", j + 1);
          j = e === -1 ? n : e + 1;
          continue;
        }
        if (cc === '"') {
          let k = j + 1;
          while (k < n) {
            if (input[k] === "\\" && k + 1 < n) {
              k += 2;
              continue;
            }
            if (input[k] === '"') {
              k++;
              break;
            }
            k++;
          }
          j = k;
          continue;
        }
        if (cc === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (cc === "(") depth++;
        else if (cc === ")") depth--;
        j++;
      }
      const endInner = depth === 0 ? j - 1 : n;
      flushCmd();
      toks.push({ kind: "group", text: input.slice(startInner, endInner) });
      i = j;
      continue;
    }
    // --- Operators: && || | ; & ---
    if (c === "&" && input[i + 1] === "&") {
      flushCmd();
      toks.push({ kind: "sep", text: "&&" });
      i += 2;
      continue;
    }
    if (c === "|" && input[i + 1] === "|") {
      flushCmd();
      toks.push({ kind: "sep", text: "||" });
      i += 2;
      continue;
    }
    if (c === "|") {
      flushCmd();
      toks.push({ kind: "sep", text: "|" });
      i++;
      continue;
    }
    if (c === ";") {
      flushCmd();
      toks.push({ kind: "sep", text: ";" });
      i++;
      continue;
    }
    if (c === "&") {
      flushCmd();
      toks.push({ kind: "sep", text: "&" });
      i++;
      continue;
    }
    // newline acts like ;
    if (c === "\n") {
      flushCmd();
      toks.push({ kind: "sep", text: ";" });
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flushCmd();
  return toks;
}

/**
 * Flatten a command string into a list of atomic sub-commands.
 *
 * @param input The raw command string from the agent
 * @returns Trimmed sub-commands; never empty if input has any non-whitespace
 *          content (input itself returned as fallback). Recurses into
 *          subshells and command substitutions.
 */
export function flattenCommand(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];
  const toks = tokenize(trimmed);
  const out: string[] = [];
  for (const t of toks) {
    if (t.kind === "sep") continue;
    if (t.kind === "cmd") {
      out.push(t.text);
    } else {
      // group: recurse so nested operators are flattened too
      const inner = flattenCommand(t.text);
      out.push(...inner);
    }
  }
  // If parsing produced no atoms (e.g. only separators), fall back to the
  // whole input so the caller still has something to test.
  if (out.length === 0) return [trimmed];
  return out;
}
