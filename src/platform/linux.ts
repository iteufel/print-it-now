/**
 * Side-effect import for `bun build --compile` / `Bun.build({ compile })`.
 *
 * The `.node` files must be static ESM imports with `{ type: "file" }`.
 * `createRequire()("….node")` is not followed by `Bun.build()`, so a compiled
 * executable would ship with no addon. Importing this file is what embeds the
 * Linux binaries:
 *
 *   import "print-it-now/platform/linux";
 *   import { printPdf } from "print-it-now";
 *
 * Select the runtime libc before loading; probing another ABI can crash.
 * prebuildify `--tag-libc` names the files `print-it-now.glibc.node` and
 * `print-it-now.musl.node`.
 */

import linuxX64Musl from "../../prebuilds/linux-x64/print-it-now.musl.node" with { type: "file" };
import linuxArm64Musl from "../../prebuilds/linux-arm64/print-it-now.musl.node" with { type: "file" };
import linuxX64Glibc from "../../prebuilds/linux-x64/print-it-now.glibc.node" with { type: "file" };
import linuxArm64Glibc from "../../prebuilds/linux-arm64/print-it-now.glibc.node" with { type: "file" };
import { loadEmbedded } from "./register.js";

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return report?.header?.glibcVersionRuntime == null;
  } catch {
    return false;
  }
}

if (process.platform === "linux") {
  const arm64 = process.arch === "arm64";
  loadEmbedded(isMusl()
    ? (arm64 ? linuxArm64Musl : linuxX64Musl)
    : (arm64 ? linuxArm64Glibc : linuxX64Glibc));
}

export {};
