import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BackendError,
  InvalidOptionError,
  JobNotFoundError,
  NoPrinterError,
  PrintError,
  PrinterNotFoundError,
  UnsupportedOptionError,
  cancelJob,
  getBackendInfo,
  getJob,
  knownPaperSizeNames,
  listPrinters,
  parsePageRanges,
  printPdf,
} from "../../dist/index.js";
import { makePdf } from "../helpers/pdf.mjs";

describe("public surface", () => {
  it("exports the documented functions", () => {
    for (const fn of [
      printPdf,
      listPrinters,
      getJob,
      cancelJob,
      getBackendInfo,
      parsePageRanges,
      knownPaperSizeNames,
    ]) {
      assert.equal(typeof fn, "function");
    }
  });

  it("exports error classes that all derive from PrintError", () => {
    for (const ErrorClass of [
      InvalidOptionError,
      UnsupportedOptionError,
      NoPrinterError,
      PrinterNotFoundError,
      BackendError,
      JobNotFoundError,
    ]) {
      assert.ok(
        Object.create(ErrorClass.prototype) instanceof PrintError,
        `${ErrorClass.name} should extend PrintError`,
      );
    }
  });

  it("gives every error a code and a self-describing name", () => {
    const error = new InvalidOptionError("copies", "must be positive");
    assert.equal(error.code, "EINVALIDOPTION");
    assert.equal(error.name, "InvalidOptionError");
    assert.equal(error.option, "copies");
    assert.ok(error instanceof Error);
  });

  it("lists paper sizes callers can pass by name", () => {
    const names = knownPaperSizeNames();
    assert.ok(names.includes("A4"));
    assert.ok(names.includes("Letter"));
  });
});

describe("printPdf input validation", () => {
  // These all reject before any backend is consulted, so they pass on a machine
  // with no printer at all.
  it("rejects an empty file path", async () => {
    await assert.rejects(printPdf("   "), { code: "EINVALIDOPTION", option: "source" });
  });

  it("rejects empty PDF data", async () => {
    await assert.rejects(printPdf(Buffer.alloc(0)), {
      code: "EINVALIDOPTION",
      option: "source",
    });
  });

  it("rejects a source that is neither a path nor bytes", async () => {
    for (const source of [42, null, undefined, {}, true]) {
      await assert.rejects(printPdf(source), { code: "EINVALIDOPTION", option: "source" });
    }
  });

  it("rejects bad options before touching the printing subsystem", async () => {
    await assert.rejects(printPdf(makePdf(), { copies: 0 }), {
      code: "EINVALIDOPTION",
      option: "copies",
    });
    await assert.rejects(printPdf(makePdf(), { pages: "not-a-range" }), {
      code: "EINVALIDOPTION",
      option: "pages",
    });
  });

  it("accepts a Uint8Array as well as a Buffer", async () => {
    // Only the source check is under test, so the printer name is deliberately
    // one that cannot exist: reaching a printer error means the source passed.
    const pdf = makePdf();
    const asUint8 = new Uint8Array(pdf);
    await assert.rejects(
      printPdf(asUint8, { printer: "\u0000no-such-printer" }),
      (error) => error instanceof PrintError && error.code !== "EINVALIDOPTION",
    );
  });
});

describe("getJob and cancelJob validation", () => {
  it("rejects an empty printer name", async () => {
    await assert.rejects(getJob("", 1), { code: "EINVALIDOPTION", option: "printer" });
    await assert.rejects(cancelJob("  ", 1), { code: "EINVALIDOPTION", option: "printer" });
  });

  it("rejects a non-integer job id", async () => {
    await assert.rejects(getJob("Queue", 1.5), { code: "EINVALIDOPTION", option: "jobId" });
    await assert.rejects(cancelJob("Queue", Number.NaN), {
      code: "EINVALIDOPTION",
      option: "jobId",
    });
  });
});

describe("getBackendInfo", () => {
  it("names the backend compiled for this platform", async () => {
    const info = await getBackendInfo();
    const expected = process.platform === "win32" ? ["windows"] : ["cups", "lp-fallback"];
    assert.ok(
      expected.includes(info.backend),
      `expected one of ${expected.join(", ")}, got ${info.backend}`,
    );
  });
});
