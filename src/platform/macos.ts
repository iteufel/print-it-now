/**
 * Side-effect import for `bun build --compile`.
 *
 * Bun only embeds N-API addons that it can see as `require("./file.node")` with
 * a string literal. `node-gyp-build` builds that path at runtime, so a compiled
 * executable cannot find `prebuilds/` on disk. Importing this file is what
 * makes the Darwin binaries part of the bundle:
 *
 *   import "print-it-now/platform/macos";
 *   import { printPdf } from "print-it-now";
 *
 * Each `require` is wrapped in try/catch so a machine that only has one Darwin
 * arch (or a source checkout with no prebuilds) still loads.
 */

import { createRequire } from "node:module";
import { accept } from "./register.js";

const require = createRequire(import.meta.url);

try {
  accept(require("../../prebuilds/darwin-arm64/node.napi.node"));
} catch {
  // Wrong arch, or the prebuild is not in this install.
}
try {
  accept(require("../../prebuilds/darwin-x64/node.napi.node"));
} catch {
  // Wrong arch, or the prebuild is not in this install.
}

export {};
