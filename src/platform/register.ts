import type { NativeAddon } from "../binding.js";

/**
 * Shared with `src/binding.ts` via `Symbol.for`. A Bun `--compile` build
 * inlines the importer into the executable, so a module-local `let cached`
 * in the published ESM build is a different slot from this file. The
 * well-known symbol is the one place both sides can meet.
 */
export const NATIVE_ADDON = Symbol.for("print-it-now.nativeAddon");

export function accept(addon: unknown): void {
  if (addon == null || typeof addon !== "object") return;
  const slots = globalThis as Record<symbol, NativeAddon | undefined>;
  if (slots[NATIVE_ADDON] == null) {
    slots[NATIVE_ADDON] = addon as NativeAddon;
  }
}
