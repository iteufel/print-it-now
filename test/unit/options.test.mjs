import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNativeRequest,
  resolveOptions,
  toIppOptions,
  toWindowsSettings,
} from "../../dist/internal.js";

/** IPP attributes as a plain object, for readable assertions. */
function ipp(options) {
  return Object.fromEntries(toIppOptions(resolveOptions(options)));
}

function windows(options) {
  return toWindowsSettings(resolveOptions(options));
}

describe("resolveOptions defaults", () => {
  it("fills in the defaults a bare call relies on", () => {
    const resolved = resolveOptions();
    assert.equal(resolved.copies, 1);
    assert.equal(resolved.collate, true);
    assert.equal(resolved.scale, "shrink");
    assert.equal(resolved.subset, "all");
    assert.equal(resolved.reverse, false);
    assert.equal(resolved.numberUp, 1);
    assert.deepEqual(resolved.ranges, []);
    assert.equal(resolved.windows.renderMode, "vector");
    assert.equal(resolved.windows.printMode, "emf");
  });

  it("does not invent values for options that were not given", () => {
    // A driver's own defaults must survive; inventing "portrait" here would
    // override a queue configured for landscape.
    const resolved = resolveOptions();
    assert.equal(resolved.duplex, undefined);
    assert.equal(resolved.orientation, undefined);
    assert.equal(resolved.paperSize, undefined);
    assert.equal(resolved.color, undefined);
    assert.equal(resolved.quality, undefined);
    assert.equal(resolved.tray, undefined);
    assert.equal(resolved.dpi, undefined);
  });
});

describe("resolveOptions validation", () => {
  for (const [options, option] of [
    [{ copies: 0 }, "copies"],
    [{ copies: -1 }, "copies"],
    [{ copies: 1.5 }, "copies"],
    [{ copies: "2" }, "copies"],
    [{ printer: "" }, "printer"],
    [{ printer: "   " }, "printer"],
    [{ printer: 42 }, "printer"],
    [{ jobName: 42 }, "jobName"],
    [{ collate: "yes" }, "collate"],
    [{ reverse: "yes" }, "reverse"],
    [{ numberUp: 3 }, "numberUp"],
    [{ numberUp: 0 }, "numberUp"],
    [{ dpi: 10 }, "dpi"],
    [{ dpi: 9600 }, "dpi"],
    [{ dpi: 300.5 }, "dpi"],
    [{ duplex: "both" }, "duplex"],
    [{ orientation: "sideways" }, "orientation"],
    [{ color: "greyscale" }, "color"],
    [{ quality: "best" }, "quality"],
    [{ scale: "stretch" }, "scale"],
    [{ pageSubset: "first" }, "pageSubset"],
    [{ paperSize: "A99" }, "paperSize"],
    [{ paperSize: { widthMm: 0, heightMm: 100 } }, "paperSize"],
    [{ paperSize: { widthMm: 100 } }, "paperSize"],
    [{ paperSize: { widthMm: 5000, heightMm: 100 } }, "paperSize"],
    [{ tray: 0 }, "tray"],
    [{ tray: 1.5 }, "tray"],
    [{ tray: "" }, "tray"],
    [{ ipp: [] }, "ipp"],
    [{ ipp: { copies: 3 } }, "ipp"],
    [{ windows: { renderMode: "raster" } }, "windows.renderMode"],
    [{ windows: { printMode: "pcl" } }, "windows.printMode"],
  ]) {
    it(`rejects ${JSON.stringify(options)}`, () => {
      assert.throws(() => resolveOptions(options), {
        code: "EINVALIDOPTION",
        option,
      });
    });
  }

  it("names the offending option in the message", () => {
    assert.throws(() => resolveOptions({ copies: 0 }), /Invalid value for option "copies"/);
  });

  it("lists the known paper sizes when one is misspelled", () => {
    assert.throws(() => resolveOptions({ paperSize: "A4Plus" }), /Known names: .*A4/);
  });
});

describe("IPP mapping", () => {
  it("sends nothing for a bare request, so the queue's own defaults apply", () => {
    assert.deepEqual(ipp({}), {});
  });

  it("maps copies together with a collation instruction", () => {
    assert.deepEqual(ipp({ copies: 3 }), {
      copies: "3",
      "multiple-document-handling": "separate-documents-collated-copies",
    });
    assert.equal(
      ipp({ copies: 3, collate: false })["multiple-document-handling"],
      "separate-documents-uncollated-copies",
    );
  });

  it("omits copies when only one is wanted", () => {
    // Sending copies=1 is redundant, and some queues log it as an override.
    assert.equal(ipp({ copies: 1 }).copies, undefined);
    assert.equal(ipp({ copies: 1 })["multiple-document-handling"], undefined);
  });

  it("maps page selection", () => {
    assert.equal(ipp({ pages: "1-3,7" })["page-ranges"], "1-3,7-7");
    assert.equal(ipp({ pageSubset: "odd" })["page-set"], "odd");
    assert.equal(ipp({ reverse: true }).outputorder, "reverse");
  });

  it("maps duplex onto IPP sides", () => {
    assert.equal(ipp({ duplex: "simplex" }).sides, "one-sided");
    assert.equal(ipp({ duplex: "long-edge" }).sides, "two-sided-long-edge");
    assert.equal(ipp({ duplex: "short-edge" }).sides, "two-sided-short-edge");
  });

  it("maps orientation onto the IPP enum", () => {
    assert.equal(ipp({ orientation: "portrait" })["orientation-requested"], "3");
    assert.equal(ipp({ orientation: "landscape" })["orientation-requested"], "4");
  });

  it("uses self-describing PWG media names", () => {
    // PWG names work on both PPD-based and driverless queues, unlike the legacy
    // short names, which depend on the PPD having that exact page size.
    assert.equal(ipp({ paperSize: "A4" }).media, "iso_a4_210x297mm");
    assert.equal(ipp({ paperSize: "Letter" }).media, "na_letter_8.5x11in");
    assert.equal(ipp({ paperSize: "us letter" }).media, "na_letter_8.5x11in");
  });

  it("expresses a custom size in millimetres", () => {
    assert.equal(ipp({ paperSize: { widthMm: 210, heightMm: 297 } }).media, "Custom.210x297mm");
  });

  it("treats color: auto as no instruction at all", () => {
    assert.equal(ipp({ color: "auto" })["print-color-mode"], undefined);
    assert.equal(ipp({ color: "color" })["print-color-mode"], "color");
    assert.equal(ipp({ color: "monochrome" })["print-color-mode"], "monochrome");
  });

  it("maps quality onto the IPP enum", () => {
    assert.equal(ipp({ quality: "draft" })["print-quality"], "3");
    assert.equal(ipp({ quality: "normal" })["print-quality"], "4");
    assert.equal(ipp({ quality: "high" })["print-quality"], "5");
  });

  it("maps scaling onto fit-to-page", () => {
    assert.equal(ipp({ scale: "fit" })["fit-to-page"], "true");
    assert.equal(ipp({ scale: "actual" })["fit-to-page"], "false");
    // `shrink` is the package default rather than an explicit request, and CUPS
    // has no shrink-only mode, so the queue's own policy is left alone.
    assert.equal(ipp({ scale: "shrink" })["fit-to-page"], undefined);
  });

  it("lets a caller's raw attribute win over a derived one", () => {
    assert.equal(ipp({ copies: 2, ipp: { copies: "9" } }).copies, "9");
  });

  it("passes through attributes it has no opinion about", () => {
    assert.equal(ipp({ ipp: { "job-priority": "80" } })["job-priority"], "80");
  });
});

describe("IPP mapping rejects what CUPS cannot do", () => {
  it("refuses dpi, which CUPS decides for itself", () => {
    assert.throws(() => ipp({ dpi: 300 }), {
      code: "EUNSUPPORTEDOPTION",
      option: "dpi",
      platform: "cups",
    });
  });

  it("refuses noscale-clip, which CUPS cannot anchor", () => {
    assert.throws(() => ipp({ scale: "noscale-clip" }), {
      code: "EUNSUPPORTEDOPTION",
      platform: "cups",
    });
  });

  it("downgrades to a no-op when the caller opts in", () => {
    const attributes = ipp({ dpi: 300, ignoreUnsupportedOptions: true });
    assert.equal(attributes.dpi, undefined);
    assert.equal(attributes["print-quality"], undefined);
  });

  it("explains itself rather than just refusing", () => {
    assert.throws(() => ipp({ dpi: 300 }), /queue's resolution/);
  });
});

describe("DEVMODE mapping", () => {
  it("sets only the render controls for a bare request", () => {
    // Every unset field means "leave the driver's default alone", which is what
    // keeps a queue's configured duplex or tray from being silently overridden.
    assert.deepEqual(windows({}), { renderMode: 0, printMode: 0, dpi: 0 });
  });

  it("maps orientation onto DMORIENT", () => {
    assert.equal(windows({ orientation: "portrait" }).orientation, 1);
    assert.equal(windows({ orientation: "landscape" }).orientation, 2);
  });

  it("maps duplex onto DMDUP", () => {
    assert.equal(windows({ duplex: "simplex" }).duplex, 1);
    // DMDUP_VERTICAL flips on the long edge, DMDUP_HORIZONTAL on the short one.
    assert.equal(windows({ duplex: "long-edge" }).duplex, 2);
    assert.equal(windows({ duplex: "short-edge" }).duplex, 3);
  });

  it("maps colour, leaving auto to the driver", () => {
    assert.equal(windows({ color: "monochrome" }).color, 1);
    assert.equal(windows({ color: "color" }).color, 2);
    assert.equal(windows({ color: "auto" }).color, undefined);
  });

  it("maps quality onto the negative DMRES bands", () => {
    // The values are negative so a driver can tell a quality band apart from a
    // literal DPI in the same field.
    assert.equal(windows({ quality: "draft" }).quality, -1);
    assert.equal(windows({ quality: "normal" }).quality, -3);
    assert.equal(windows({ quality: "high" }).quality, -4);
  });

  it("only asks for collation when there is more than one copy", () => {
    assert.equal(windows({}).collate, undefined);
    assert.equal(windows({ copies: 2 }).collate, 1);
    assert.equal(windows({ copies: 2, collate: false }).collate, 0);
  });

  it("maps named paper sizes onto DMPAPER constants", () => {
    assert.equal(windows({ paperSize: "A4" }).paperSize, 9);
    assert.equal(windows({ paperSize: "Letter" }).paperSize, 1);
    assert.equal(windows({ paperSize: "Legal" }).paperSize, 5);
    assert.equal(windows({ paperSize: "A3" }).paperSize, 8);
  });

  it("falls back to explicit dimensions for sizes Windows has no constant for", () => {
    // A0 has no DMPAPER_* value, so it has to be requested as a custom size.
    const a0 = windows({ paperSize: "A0" });
    assert.equal(a0.paperSize, 256, "DMPAPER_USER");
    assert.equal(a0.paperWidth, 8410, "tenths of a millimetre");
    assert.equal(a0.paperLength, 11890);
  });

  it("expresses a custom size in tenths of a millimetre", () => {
    const custom = windows({ paperSize: { widthMm: 100, heightMm: 150.5 } });
    assert.equal(custom.paperSize, 256);
    assert.equal(custom.paperWidth, 1000);
    assert.equal(custom.paperLength, 1505);
  });

  it("maps tray names onto DMBIN constants and passes numbers through", () => {
    assert.equal(windows({ tray: "auto" }).bin, 7);
    assert.equal(windows({ tray: "manual" }).bin, 4);
    assert.equal(windows({ tray: "upper" }).bin, 1);
    // Drivers number their own trays above DMBIN_USER, so a raw id has to work.
    assert.equal(windows({ tray: 258 }).bin, 258);
  });

  it("rejects a tray name it cannot map", () => {
    assert.throws(() => windows({ tray: "tray-4" }), {
      code: "EINVALIDOPTION",
      option: "tray",
    });
  });

  it("maps the PDFium print modes", () => {
    assert.equal(windows({ windows: { printMode: "emf" } }).printMode, 0);
    assert.equal(windows({ windows: { printMode: "postscript3" } }).printMode, 3);
    assert.equal(
      windows({ windows: { printMode: "postscript3-type42-passthrough" } }).printMode,
      8,
    );
  });

  it("selects the bitmap render path", () => {
    assert.equal(windows({ windows: { renderMode: "bitmap" } }).renderMode, 1);
  });

  it("passes an output file through for file-backed drivers", () => {
    assert.equal(
      windows({ windows: { outputFile: "C:\\out.pdf" } }).outputFile,
      "C:\\out.pdf",
    );
  });

  it("refuses numberUp, which DEVMODE cannot describe", () => {
    assert.throws(() => windows({ numberUp: 2 }), {
      code: "EUNSUPPORTEDOPTION",
      option: "numberUp",
      platform: "windows",
    });
  });
});

describe("buildNativeRequest", () => {
  const source = { filePath: "/tmp/a.pdf" };

  it("encodes the enums the native reader expects", () => {
    const request = buildNativeRequest(
      resolveOptions({ pageSubset: "even", scale: "fit", reverse: true }),
      "Queue",
      "Title",
      source,
      "cups",
    );
    assert.equal(request.subset, 2);
    assert.equal(request.scale, 1);
    assert.equal(request.reverse, true);
    assert.equal(request.printer, "Queue");
    assert.equal(request.jobName, "Title");
    assert.equal(request.filePath, "/tmp/a.pdf");
  });

  it("turns an open-ended range into the native end-of-document sentinel", () => {
    const request = buildNativeRequest(resolveOptions({ pages: "3-" }), "Q", "T", source, "cups");
    assert.deepEqual(request.ranges, [{ from: 3, to: 0 }]);
  });

  it("only builds the active backend's half", () => {
    const cups = buildNativeRequest(resolveOptions({ copies: 2 }), "Q", "T", source, "cups");
    assert.ok(cups.ipp.length > 0, "CUPS gets IPP attributes");
    assert.equal(cups.kind, 0);

    const win = buildNativeRequest(resolveOptions({ copies: 2 }), "Q", "T", source, "windows");
    assert.deepEqual(win.ipp, [], "Windows gets none");
    assert.equal(win.windows.collate, 1);
    assert.equal(win.kind, 0);
  });

  it("does not report an option as unsupported when the active backend supports it", () => {
    // numberUp is unsupported on Windows and supported on CUPS. Building a CUPS
    // request must not run the Windows mapping, or a perfectly valid Linux job
    // would be rejected.
    const request = buildNativeRequest(
      resolveOptions({ numberUp: 2 }),
      "Q",
      "T",
      source,
      "cups",
    );
    assert.equal(Object.fromEntries(request.ipp)["number-up"], "2");
  });

  it("always provides a windows object, since the native reader requires one", () => {
    const request = buildNativeRequest(resolveOptions({}), "Q", "T", source, "cups");
    assert.equal(typeof request.windows.renderMode, "number");
    assert.equal(typeof request.windows.printMode, "number");
    assert.equal(typeof request.windows.dpi, "number");
  });
});
