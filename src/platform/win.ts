/**
 * Side-effect import for `bun build --compile` / `Bun.build({ compile })`.
 *
 * The `.node` files and `pdfium.dll` must be static ESM imports with
 * `{ type: "file" }`. `createRequire()("….node")` is not followed by
 * `Bun.build()`, so a compiled executable would ship with no addon.
 *
 *   import "print-it-now/platform/win";
 *   import { printPdf } from "print-it-now";
 *
 * `pdfium.dll` is read with `Bun.file()` as documented for compiled executables.
 * `LoadLibrary` cannot open `/$bunfs/`, so the bytes are written to a real
 * temp file and `PRINT_IT_NOW_PDFIUM_PATH` points at it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file } from "bun";
import win32X64 from "../../prebuilds/win32-x64/print-it-now.glibc.node" with { type: "file" };
import win32Arm64 from "../../prebuilds/win32-arm64/print-it-now.glibc.node" with { type: "file" };
import pdfiumX64 from "../../prebuilds/win32-x64/pdfium.dll" with { type: "file" };
import pdfiumArm64 from "../../prebuilds/win32-arm64/pdfium.dll" with { type: "file" };
import { loadEmbedded } from "./register.js";

async function stagePdfium(embeddedPath: string): Promise<void> {
  if (process.env["PRINT_IT_NOW_PDFIUM_PATH"]) return;
  // A loaded DLL is locked on Windows. Each process needs its own directory,
  // so concurrent instances and different app versions never overwrite it.
  const dest = join(mkdtempSync(join(tmpdir(), "print-it-now-")), "pdfium.dll");
  writeFileSync(dest, Buffer.from(await file(embeddedPath).arrayBuffer()));
  process.env["PRINT_IT_NOW_PDFIUM_PATH"] = dest;
}

if (process.platform === "win32") {
  await stagePdfium(process.arch === "arm64" ? pdfiumArm64 : pdfiumX64);
  loadEmbedded(process.arch === "arm64" ? win32Arm64 : win32X64);
}
