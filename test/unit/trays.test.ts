import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";

import { listTrays } from "../../src/index.js";
import {
  lpFallback,
  paperBinName,
  registerNative,
  resetBackendCache,
  resetNativeCache,
} from "../../src/internal.js";
import type { NativeAddon } from "../../src/binding.js";

const { parseLpoptionsTrays } = lpFallback;

describe("paperBinName", () => {
  it("returns the canonical DMBIN name for a standard id", () => {
    assert.equal(paperBinName(1), "upper");
    assert.equal(paperBinName(4), "manual");
    assert.equal(paperBinName(7), "auto");
    assert.equal(paperBinName(14), "cassette");
  });

  it("leaves driver-specific ids unmapped", () => {
    assert.equal(paperBinName(256), undefined);
    assert.equal(paperBinName(258), undefined);
  });
});

describe("parseLpoptionsTrays", () => {
  it("reads media-source from a driverless queue", () => {
    const trays = parseLpoptionsTrays(`
media/Media Size: *iso_a4_210x297mm na_letter_8.5x11in
media-source/Media Source: *auto main tray-1
sides/2-Sided Printing: *one-sided two-sided-long-edge
`);
    assert.deepEqual(trays, [
      { name: "auto", isDefault: true },
      { name: "main", isDefault: false },
      { name: "tray-1", isDefault: false },
    ]);
  });

  it("reads InputSlot from a PPD queue", () => {
    const trays = parseLpoptionsTrays(`
PageSize/Page Size: *A4 Letter Legal
InputSlot/Media Source: Auto *Cassette ManualFeed
`);
    assert.deepEqual(trays, [
      { name: "Auto", isDefault: false },
      { name: "Cassette", isDefault: true },
      { name: "ManualFeed", isDefault: false },
    ]);
  });

  it("prefers media-source when both are present", () => {
    const trays = parseLpoptionsTrays(`
InputSlot/Media Source: Cassette
media-source/Media Source: *auto main
`);
    assert.deepEqual(trays, [
      { name: "auto", isDefault: true },
      { name: "main", isDefault: false },
    ]);
  });

  it("returns an empty list when the queue has no tray option", () => {
    assert.deepEqual(parseLpoptionsTrays("PageSize/Page Size: *A4 Letter\n"), []);
  });
});

describe("listTrays mapping", () => {
  afterEach(() => {
    resetNativeCache();
    resetBackendCache();
  });

  it("maps Windows bin ids onto DMBIN names and leaves driver ids numeric", async () => {
    const previous = process.env["PRINT_IT_NOW_BACKEND"];
    delete process.env["PRINT_IT_NOW_BACKEND"];
    try {
      registerNative({
        describe: async () => ({ backend: "windows" }),
        listTrays: async () => [
          { id: 7, displayName: "Automatically Select", isDefault: true },
          { id: 1, displayName: "Upper Cassette" },
          { id: 258, displayName: "Tray 4" },
        ],
      } as unknown as NativeAddon);
      resetBackendCache();

      const trays = await listTrays("Office Laser");
      assert.deepEqual(trays, [
        { name: "auto", displayName: "Automatically Select", isDefault: true },
        { name: "upper", displayName: "Upper Cassette", isDefault: false },
        { name: 258, displayName: "Tray 4", isDefault: false },
      ]);
    } finally {
      if (previous === undefined) delete process.env["PRINT_IT_NOW_BACKEND"];
      else process.env["PRINT_IT_NOW_BACKEND"] = previous;
    }
  });

  it("passes CUPS media-source keywords through", async () => {
    const previous = process.env["PRINT_IT_NOW_BACKEND"];
    delete process.env["PRINT_IT_NOW_BACKEND"];
    try {
      registerNative({
        describe: async () => ({ backend: "cups" }),
        listTrays: async () => [
          { name: "auto", displayName: "Automatic", isDefault: true },
          { name: "tray-1" },
        ],
      } as unknown as NativeAddon);
      resetBackendCache();

      const trays = await listTrays("Office Laser");
      assert.deepEqual(trays, [
        { name: "auto", displayName: "Automatic", isDefault: true },
        { name: "tray-1", isDefault: false },
      ]);
    } finally {
      if (previous === undefined) delete process.env["PRINT_IT_NOW_BACKEND"];
      else process.env["PRINT_IT_NOW_BACKEND"] = previous;
    }
  });
});
