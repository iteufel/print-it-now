#!/usr/bin/env node
/**
 * Runs the test files in the given directories through Node's test runner.
 *
 * The file list is built here rather than left to a glob because neither end of
 * that handles it portably: `node --test` only learned to expand glob patterns in
 * Node 22, and shells disagree about whether they expand a pattern at all --
 * bash does, PowerShell does not. Passing explicit paths behaves the same on
 * every supported Node version and every platform.
 *
 * Usage: node scripts/run-tests.mjs test/unit [test/e2e ...]
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const directories = process.argv.slice(2);
if (directories.length === 0) {
  process.stderr.write("Usage: node scripts/run-tests.mjs <directory> [directory ...]\n");
  process.exit(2);
}

const files = [];
for (const directory of directories) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    process.stderr.write(`Cannot read ${directory}: ${error.message}\n`);
    process.exit(1);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && /\.test\.mjs$/.test(entry.name)) files.push(join(directory, entry.name));
  }
}

if (files.length === 0) {
  process.stderr.write(`No *.test.mjs files found in ${directories.join(", ")}\n`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("close", (code, signal) => {
  if (signal) {
    process.stderr.write(`Test runner terminated by ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
