import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";

import { loadNative, registerNative, resetNativeCache } from "../../src/internal.js";
import type { NativeAddon } from "../../src/binding.js";

describe("registerNative", () => {
  afterEach(() => {
    resetNativeCache();
  });

  it("loadNative returns a previously registered addon instead of searching prebuilds", () => {
    const fake = {
      describe: async () => ({ backend: "cups" }),
    } as NativeAddon;
    registerNative(fake);
    assert.equal(loadNative(), fake);
  });

  it("a later registerNative replaces the addon the next loadNative call sees", () => {
    const first = { describe: async () => ({ backend: "cups" }) } as NativeAddon;
    const second = { describe: async () => ({ backend: "windows" }) } as NativeAddon;
    registerNative(first);
    registerNative(second);
    assert.equal(loadNative(), second);
  });
});
