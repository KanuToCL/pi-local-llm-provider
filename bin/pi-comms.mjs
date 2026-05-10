#!/usr/bin/env node
// pi-comms launcher — resolves the CLI entry (built JS preferred, tsx
// fallback for source) and execs it with the user's argv. Installed as
// the `pi-comms` bin via package.json `bin`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(here), "..");

const distEntry = join(repoRoot, "dist", "bin", "pi-comms.js");
const tsEntry = join(repoRoot, "bin", "pi-comms.ts");
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");

let cmd;
let args;
if (existsSync(distEntry)) {
  cmd = process.execPath;
  args = [distEntry, ...process.argv.slice(2)];
} else if (existsSync(tsx) && existsSync(tsEntry)) {
  cmd = tsx;
  args = [tsEntry, ...process.argv.slice(2)];
} else {
  process.stderr.write(
    `pi-comms: cannot launch — run \`npm install\` (or \`npm run build\`) in ${repoRoot} first.\n`,
  );
  process.exit(2);
}

const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
