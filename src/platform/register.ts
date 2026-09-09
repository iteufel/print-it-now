import { createRequire } from "node:module";
import type { NativeAddon } from "../binding.js";

/**
 * Shared with `src/binding.ts` via `Symbol.for`. A Bun `--compile` build
 * inlines the importer into the executable, so a module-local `let cached`
 * in the published ESM build is a different slot from this file. The
 * well-known symbol is the one place both sides can meet.
 */
export const NATIVE_ADDON = Symbol.for("print-it-now.nativeAddon");

const require = createRequire(import.meta.url);

export function accept(addon: unknown): void {
  if (addon == null || typeof addon !== "object") return;
  const slots = globalThis as Record<symbol, NativeAddon | undefined>;
  if (slots[NATIVE_ADDON] == null) {
    slots[NATIVE_ADDON] = addon as NativeAddon;
  }
}

/**
 * Loads an addon that was embedded with `import "….node" with { type: "file" }`.
 *
 * `createRequire("…/file.node")` is invisible to `Bun.build()` (and minify can
 * drop it). A static `type: "file"` import is what the bundler follows; this
 * then `require`s the `/$bunfs/` path at runtime so the matching arch is
 * `dlopen`ed without evaluating the others.
 */
export function loadEmbedded(embeddedPath: string): void {
  // Only the matching platform/architecture calls this. Preserve dlopen errors
  // (missing libraries, incompatible binaries) instead of hiding them as an
  // unembedded addon or silently falling back to command-line printing.
  accept(require(embeddedPath));
}
