/**
 * The shortest `bun build --compile` app that can print.
 *
 * Bun only embeds N-API addons that it can see as `require("./file.node")`
 * with a string literal. Import the platform you are compiling for (or
 * `print-it-now/platform` for every OS, which also embeds `pdfium.dll`):
 *
 *   import "print-it-now/platform/win";
 *   import "print-it-now/platform/macos";
 *   import "print-it-now/platform/linux";
 *
 *   bun build --compile examples/bun-compile.mjs --outfile myapp
 */

import "print-it-now/platform/macos";
import { listPrinters } from "print-it-now";

for (const printer of await listPrinters()) {
  console.log(printer.name);
}
