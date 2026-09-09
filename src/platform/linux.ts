/**
 * Side-effect import for `bun build --compile`.
 *
 * Bun only embeds N-API addons that it can see as `require("./file.node")` with
 * a string literal. `node-gyp-build` builds that path at runtime, so a compiled
 * executable cannot find `prebuilds/` on disk. Importing this file is what
 * makes the Linux binaries part of the bundle:
 *
 *   import "print-it-now/platform/linux";
 *   import { printPdf } from "print-it-now";
 *
 * musl is tried first so an Alpine build does not pick a glibc `.node` that
 * `dlopen`s and then crashes. `accept` only stores the first object it sees.
 * Both libcs and both arches stay as string-literal `require`s so a compile
 * on Debian still embeds the Alpine binary (and vice versa).
 */

import { createRequire } from "node:module";
import { accept } from "./register.js";

const require = createRequire(import.meta.url);

try {
  accept(require("../../prebuilds/linux-x64/node.napi.musl.node"));
} catch {
  // Wrong arch/libc, or the prebuild is not in this install.
}
try {
  accept(require("../../prebuilds/linux-arm64/node.napi.musl.node"));
} catch {
  // Wrong arch/libc, or the prebuild is not in this install.
}
try {
  accept(require("../../prebuilds/linux-x64/node.napi.glibc.node"));
} catch {
  // Wrong arch/libc, or the prebuild is not in this install.
}
try {
  accept(require("../../prebuilds/linux-arm64/node.napi.glibc.node"));
} catch {
  // Wrong arch/libc, or the prebuild is not in this install.
}

export {};
