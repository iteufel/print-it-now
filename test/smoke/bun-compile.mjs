/**
 * Compiles a tiny app that imports `print-it-now/platform/<os>` and runs it.
 *
 * This is the check that `bun build --compile` actually embedded the N-API
 * addon. The regular smoke test still uses `node-gyp-build` against a source
 * build; this one needs a prebuild in `prebuilds/` (run `npm run prebuild`
 * first, and on Windows `node scripts/fetch-pdfium.mjs --target win32-x64`).
 *
 * Run with: bun test/smoke/bun-compile.mjs
 */

import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const entryByPlatform = {
  darwin: "test/smoke/compile-apps/macos.mjs",
  linux: "test/smoke/compile-apps/linux.mjs",
  win32: "test/smoke/compile-apps/win.mjs",
};

const entry = entryByPlatform[process.platform];
if (!entry) {
  process.stderr.write(`No compile fixture for ${process.platform}\n`);
  process.exit(2);
}

const prebuildDir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
if (!existsSync(prebuildDir)) {
  process.stderr.write(
    `No prebuild at ${prebuildDir}. Run \`npm run prebuild\` first` +
      (process.platform === "win32" ? ", then fetch-pdfium for this target.\n" : ".\n"),
  );
  process.exit(2);
}

const outDir = join(root, "test", ".tmp");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, process.platform === "win32" ? "pin-compile.exe" : "pin-compile");

process.stdout.write(`bun build --compile ${entry} --outfile ${outfile}\n`);
const build = spawnSync("bun", ["build", "--compile", entry, "--outfile", outfile], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const built = existsSync(outfile) ? outfile : `${outfile}.exe`;
process.stdout.write(`running ${built}\n`);
const run = spawnSync(built, { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
