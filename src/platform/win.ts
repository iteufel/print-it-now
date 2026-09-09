/**
 * Side-effect import for `bun build --compile`.
 *
 * Bun only embeds N-API addons that it can see as `require("./file.node")` with
 * a string literal. `node-gyp-build` builds that path at runtime, so a compiled
 * executable cannot find `prebuilds/` on disk. Importing this file is what
 * makes the Windows binaries part of the bundle:
 *
 *   import "print-it-now/platform/win";
 *   import { printPdf } from "print-it-now";
 *
 * `pdfium.dll` is imported with `{ type: "file" }` so Bun embeds it as an
 * asset, then read with `Bun.file()` as documented for compiled executables.
 * `LoadLibrary` cannot open `/$bunfs/`, so the bytes are written to a real
 * temp file and `PRINT_IT_NOW_PDFIUM_PATH` points at it.
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file } from "bun";
import pdfiumX64 from "../../prebuilds/win32-x64/pdfium.dll" with { type: "file" };
import pdfiumArm64 from "../../prebuilds/win32-arm64/pdfium.dll" with { type: "file" };
import { accept } from "./register.js";

const require = createRequire(import.meta.url);

try {
  accept(require("../../prebuilds/win32-x64/node.napi.node"));
} catch {
  // Wrong arch, or the prebuild is not in this install.
}
try {
  accept(require("../../prebuilds/win32-arm64/node.napi.node"));
} catch {
  // Wrong arch, or the prebuild is not in this install.
}

async function stagePdfium(embeddedPath: string): Promise<void> {
  if (process.env["PRINT_IT_NOW_PDFIUM_PATH"]) return;
  const dest = join(tmpdir(), "print-it-now-pdfium.dll");
  writeFileSync(dest, Buffer.from(await file(embeddedPath).arrayBuffer()));
  process.env["PRINT_IT_NOW_PDFIUM_PATH"] = dest;
}

await stagePdfium(process.arch === "arm64" ? pdfiumArm64 : pdfiumX64);
