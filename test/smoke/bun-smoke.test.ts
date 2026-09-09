import { describe, expect, it } from "bun:test";

import { getBackendInfo, listPrinters, printPdf, PrintError } from "../../src/index.js";
import { loadNative, parsePageRanges, resolveOptions } from "../../src/internal.js";

describe("native addon under Bun", () => {
  it("loads through Node-API", () => {
    const native = loadNative();
    expect(typeof native.print).toBe("function");
    expect(typeof native.describe).toBe("function");
  });

  it("marshals synchronous native calls", () => {
    const native = loadNative();
    expect(native._expandPageSelection([{ from: 2, to: 4 }], 0, false, 10)).toEqual([2, 3, 4]);
    const placement = native._computePlacement(
      612,
      792,
      { dpiX: 300, dpiY: 300, printableWidth: 2450, printableHeight: 3200 },
      1,
    );
    expect(placement.width).toBe(2450);
  });

  it("resolves AsyncWorker promises", async () => {
    const info = await getBackendInfo();
    expect(typeof info.backend).toBe("string");
    expect(info.backend.length).toBeGreaterThan(0);
  });

  it("enumerates printers as an array", async () => {
    const printers = await listPrinters();
    expect(Array.isArray(printers)).toBe(true);
  });

  it("propagates native error codes", async () => {
    try {
      await printPdf(Buffer.from("not a pdf"));
      throw new Error("expected printPdf to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(PrintError);
      expect((error as PrintError).code).toBe("EINVALIDPDF");
    }
  });

  it("validates options before talking to a backend", () => {
    expect(() => resolveOptions({ copies: 0 })).toThrow();
    expect(parsePageRanges("1-3")).toEqual([{ from: 1, to: 3 }]);
  });
});
