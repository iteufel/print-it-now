import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { loadNative, registerNative, resetNativeCache } from "../../dist/internal.js";

describe("registerNative", () => {
  afterEach(() => {
    resetNativeCache();
  });

  it("loadNative returns a previously registered addon instead of searching prebuilds", () => {
    const fake = {
      describe: async () => ({ backend: "cups" }),
    };
    registerNative(fake);
    assert.equal(loadNative(), fake);
  });

  it("a later registerNative replaces the addon the next loadNative call sees", () => {
    const first = { describe: async () => ({ backend: "cups" }) };
    const second = { describe: async () => ({ backend: "windows" }) };
    registerNative(first);
    registerNative(second);
    assert.equal(loadNative(), second);
  });
});
