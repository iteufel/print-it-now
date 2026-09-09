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
import versionX64 from "../../prebuilds/win32-x64/pdfium-version.txt" with { type: "file" };
import versionArm64 from "../../prebuilds/win32-arm64/pdfium-version.txt" with { type: "file" };
import { loadEmbedded } from "./register.js";

async function stagePdfium(embeddedPath: string, versionPath: string): Promise<void> {
  if (process.env["PRINT_IT_NOW_PDFIUM_PATH"]) return;
  // A loaded DLL is locked on Windows. Each process needs its own directory,
  // so concurrent instances and different app versions never overwrite it.
  const directory = mkdtempSync(join(tmpdir(), "print-it-now-"));
  const dest = join(directory, "pdfium.dll");
  writeFileSync(dest, Buffer.from(await file(embeddedPath).arrayBuffer()));
  // The native loader reads its version from this sidecar, not DLL resources.
  writeFileSync(join(directory, "pdfium-version.txt"), Buffer.from(await file(versionPath).arrayBuffer()));
  process.env["PRINT_IT_NOW_PDFIUM_PATH"] = dest;
}

if (process.platform === "win32") {
  await stagePdfium(
    process.arch === "arm64" ? pdfiumArm64 : pdfiumX64,
    process.arch === "arm64" ? versionArm64 : versionX64,
  );
  loadEmbedded(process.arch === "arm64" ? win32Arm64 : win32X64);
}
