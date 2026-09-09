/**
 * The shortest `Bun.build({ compile })` app that can print.
 *
 * Bun embeds N-API addons from static `import "….node" with { type: "file" }`.
 * Import the platform you are compiling for (or `print-it-now/platform` for
 * every OS, which also embeds `pdfium.dll`):
 *
 *   import "print-it-now/platform/win";
 *   import "print-it-now/platform/macos";
 *   import "print-it-now/platform/linux";
 *
 *   await Bun.build({
 *     entrypoints: ["./examples/bun-compile.ts"],
 *     compile: { outfile: "myapp" },
 *   });
 */

import "print-it-now/platform/macos";
import { listPrinters } from "print-it-now";

for (const printer of await listPrinters()) {
  console.log(printer.name);
}
