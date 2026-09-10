/**
 * Public-API checks that run inside a `bun build --compile` executable.
 *
 * These have to pass on a machine with no printer, including CI, so they stop
 * at "the embedded addon answered". Windows additionally proves pdfium.dll was
 * staged from the embedded file; POSIX proves the CUPS addon loaded rather
 * than silently falling back to `lp`.
 */

import {
  getBackendInfo,
  knownPaperSizeNames,
  listPrinters,
  listTrays,
  parsePageRanges,
  printPdf,
  PrintError,
} from "print-it-now";

export async function runStandaloneChecks(): Promise<void> {
  const bun = globalThis.Bun;
  if (typeof bun !== "object" || bun.isStandaloneExecutable !== true) {
    throw new Error("expected Bun.isStandaloneExecutable");
  }

  const info = await getBackendInfo();
  if (process.platform === "win32") {
    if (info.backend !== "windows") {
      throw new Error(`expected windows backend, got ${info.backend}`);
    }
    if (typeof info.pdfiumVersion !== "string" || info.pdfiumVersion.length === 0) {
      throw new Error("pdfium.dll was not found; the compiled executable must embed it");
    }
    process.stdout.write(`  ok    backend=${info.backend} pdfium=${info.pdfiumVersion}\n`);
  } else {
    if (info.backend !== "cups") {
      throw new Error(`expected the embedded CUPS addon, got ${info.backend}`);
    }
    process.stdout.write(
      `  ok    backend=${info.backend} library=${info.cupsLibrary ?? "unknown"}\n`,
    );
  }

  const printers = await listPrinters();
  if (!Array.isArray(printers)) {
    throw new Error("listPrinters() did not return an array");
  }
  process.stdout.write(`  ok    ${printers.length} printer(s)\n`);

  if (printers.length > 0) {
    const trays = await listTrays(printers[0]!.name);
    if (!Array.isArray(trays)) {
      throw new Error("listTrays() did not return an array");
    }
    process.stdout.write(`  ok    ${trays.length} tray(s) on ${printers[0]!.name}\n`);
  }

  if (process.platform === "win32" && printers.length > 0) {
    try {
      // Pass JS's PDF header validation, then require PDFium itself to reject
      // corrupt bytes. This exercises the staged native runtime without printing.
      await printPdf(Buffer.from("%PDF-1.4\ninvalid document"), { printer: printers[0]!.name });
      throw new Error("PDFium should reject a corrupt PDF");
    } catch (error) {
      if (!(error instanceof PrintError) || error.code !== "EINVALIDPDF") throw error;
    }
  }

  try {
    await printPdf(Buffer.from("not a pdf"));
    throw new Error("invalid PDF should have been rejected");
  } catch (error) {
    if (!(error instanceof PrintError) || error.code !== "EINVALIDPDF") {
      throw error;
    }
  }

  try {
    await printPdf(Buffer.from("%PDF-1.4\n"), { copies: 0 });
    throw new Error("copies: 0 should have been rejected");
  } catch (error) {
    if (!(error instanceof PrintError) || error.code !== "EINVALIDOPTION") {
      throw error;
    }
  }

  if (JSON.stringify(parsePageRanges("1-3")) !== JSON.stringify([{ from: 1, to: 3 }])) {
    throw new Error("parsePageRanges did not parse 1-3");
  }
  if (!knownPaperSizeNames().includes("A4")) {
    throw new Error("knownPaperSizeNames() should include A4");
  }

  // Keep PDFium loaded so the Windows concurrency regression can start a
  // second executable while the first DLL remains locked by the OS.
  if (process.argv.includes("--hold")) await Bun.sleep(3_000);
  process.stdout.write("All standalone checks passed\n");
}
