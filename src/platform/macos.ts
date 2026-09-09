/**
 * Side-effect import for `bun build --compile` / `Bun.build({ compile })`.
 *
 * The `.node` files must be static ESM imports with `{ type: "file" }`.
 * `createRequire()("….node")` is not followed by `Bun.build()`, so a compiled
 * executable would ship with no addon. Importing this file is what embeds the
 * Darwin binaries:
 *
 *   import "print-it-now/platform/macos";
 *   import { printPdf } from "print-it-now";
 *
 * Both arches are imported so a compile for either Darwin target embeds both.
 * Only the matching one is `require`d at runtime. prebuildify `--tag-libc`
 * names the file `print-it-now.glibc.node` even on macOS.
 */

import darwinArm64 from "../../prebuilds/darwin-arm64/print-it-now.glibc.node" with { type: "file" };
import darwinX64 from "../../prebuilds/darwin-x64/print-it-now.glibc.node" with { type: "file" };
import { loadEmbedded } from "./register.js";

if (process.platform === "darwin") {
  loadEmbedded(process.arch === "arm64" ? darwinArm64 : darwinX64);
}

export {};
