import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  cancelJob,
  getBackendInfo,
  getJob,
  listPrinters,
  printPdf,
} from "../../dist/index.js";
import { countPdfPages, makePdf } from "../helpers/pdf.mjs";

/**
 * Prints for real, through the platform's actual printing subsystem, and checks
 * what came out the other end.
 *
 * The test needs a queue that writes to a file. scripts/setup-test-printer.sh
 * creates one and prints the environment to use:
 *
 *   PRINT_IT_NOW_TEST_PRINTER    queue name
 *   PRINT_IT_NOW_TEST_OUTPUT_DIR directory the queue writes into (POSIX)
 *   PRINT_IT_NOW_TEST_RENDERS    set when the queue runs the real filter chain,
 *                                so page counts in the output reflect the
 *                                options that were sent
 *
 * On Windows no output directory is needed: the job names its own output file
 * through `windows.outputFile`, which is also what stops a file-backed driver
 * from raising a save dialog.
 */

const isWindows = process.platform === "win32";
const printer = process.env["PRINT_IT_NOW_TEST_PRINTER"];
const outputDir = process.env["PRINT_IT_NOW_TEST_OUTPUT_DIR"];
const rendersOptions = process.env["PRINT_IT_NOW_TEST_RENDERS"] === "1";

const configured = printer !== undefined && (isWindows || outputDir !== undefined);
const skip = configured
  ? false
  : "set PRINT_IT_NOW_TEST_PRINTER (and PRINT_IT_NOW_TEST_OUTPUT_DIR on POSIX); " +
    "scripts/setup-test-printer.sh creates a suitable queue";

/** How long a queue gets to produce output before the test gives up. */
const OUTPUT_TIMEOUT_MS = Number(process.env["PRINT_IT_NOW_TEST_TIMEOUT_MS"] ?? 45000);

let workDir;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "print-it-now-e2e-"));
});

after(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a file to appear and stop growing, so a half-written PDF is never read. */
async function waitForStableFile(predicate) {
  const deadline = Date.now() + OUTPUT_TIMEOUT_MS;
  let lastSize = -1;
  let stableFor = 0;

  while (Date.now() < deadline) {
    const found = await predicate();
    if (found !== undefined) {
      const bytes = await readFile(found).catch(() => undefined);
      if (bytes !== undefined) {
        if (bytes.length === lastSize && bytes.length > 0) {
          stableFor += 1;
          // Two consecutive identical sizes means the writer has finished; a
          // single check can catch a spool file mid-write.
          if (stableFor >= 2) return bytes;
        } else {
          stableFor = 0;
          lastSize = bytes.length;
        }
      }
    }
    await sleep(400);
  }
  return undefined;
}

/**
 * Submits a job and returns the bytes the queue produced.
 *
 * On Windows the destination is chosen up front; on POSIX the queue picks the
 * filename, so the directory is watched for a file whose name carries the job
 * title.
 */
async function printAndCollect(source, options = {}) {
  const jobName = options.jobName ?? `e2e-${Math.random().toString(36).slice(2, 10)}`;

  if (isWindows) {
    const outputFile = join(workDir, `${jobName}.pdf`);
    const job = await printPdf(source, {
      ...options,
      jobName,
      printer,
      windows: { ...options.windows, outputFile },
    });
    const bytes = await waitForStableFile(async () =>
      (await readFile(outputFile).catch(() => undefined)) === undefined ? undefined : outputFile,
    );
    return { job, bytes };
  }

  const before = new Set(await readdir(outputDir).catch(() => []));
  const job = await printPdf(source, { ...options, jobName, printer });
  const bytes = await waitForStableFile(async () => {
    const now = await readdir(outputDir).catch(() => []);
    const created = now.filter((name) => !before.has(name) && name.includes(jobName));
    return created.length > 0 ? join(outputDir, created[0]) : undefined;
  });
  return { job, bytes };
}

describe("end-to-end printing", { skip }, () => {
  it("reports the backend that is doing the work", async () => {
    const info = await getBackendInfo();
    assert.equal(info.backend, isWindows ? "windows" : "cups");
    if (isWindows) {
      assert.ok(info.pdfiumVersion, "the Windows backend should report its PDFium build");
    } else {
      assert.ok(info.cupsLibrary, "the CUPS backend should report the library it resolved");
    }
  });

  it("lists the test queue", async () => {
    const printers = await listPrinters();
    assert.ok(
      printers.some((entry) => entry.name === printer),
      `expected "${printer}" among ${printers.map((p) => p.name).join(", ")}`,
    );
  });

  it("prints a PDF passed as bytes", async () => {
    const { job, bytes } = await printAndCollect(makePdf({ pages: 3, label: "bytes" }));
    assert.ok(job.jobId > 0, "a job id should come back");
    assert.equal(job.printer, printer);
    assert.ok(bytes, "the queue should have produced output");
    assert.equal(countPdfPages(bytes), 3);
  });

  it("prints a PDF passed as a file path", async () => {
    const path = join(workDir, "from-disk.pdf");
    await writeFile(path, makePdf({ pages: 2, label: "from disk" }));
    const { bytes } = await printAndCollect(path, { jobName: "e2e-from-disk" });
    assert.ok(bytes, "the queue should have produced output");
    assert.equal(countPdfPages(bytes), 2);
  });

  it("honours a page range", { skip: rendersOptions ? false : "queue does not run filters" }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 8 }), {
      jobName: "e2e-range",
      pages: "2-4",
    });
    assert.ok(bytes);
    assert.equal(countPdfPages(bytes), 3);
  });

  it("honours an open-ended page range", { skip: rendersOptions ? false : "queue does not run filters" }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 6 }), {
      jobName: "e2e-open-range",
      pages: "5-",
    });
    assert.ok(bytes);
    assert.equal(countPdfPages(bytes), 2);
  });

  it("honours an odd page subset", { skip: rendersOptions ? false : "queue does not run filters" }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 7 }), {
      jobName: "e2e-odd",
      pageSubset: "odd",
    });
    assert.ok(bytes);
    assert.equal(countPdfPages(bytes), 4);
  });

  it("honours a paper size", { skip: rendersOptions ? false : "queue does not run filters" }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 1 }), {
      jobName: "e2e-a5",
      paperSize: "A5",
    });
    assert.ok(bytes);
    const text = bytes.toString("latin1");
    // A5 is 148 x 210mm, which is 420 x 595 PostScript points.
    assert.match(text, /MediaBox\s*\[\s*0\s+0\s+42[01](\.\d+)?\s+59[45](\.\d+)?/);
  });

  it("prints multiple copies", { skip: rendersOptions ? false : "queue does not run filters" }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 2 }), {
      jobName: "e2e-copies",
      copies: 2,
    });
    assert.ok(bytes);
    // A file-backed queue collapses copies into one document, so the sheet count
    // is the only observable effect.
    assert.equal(countPdfPages(bytes), 4);
  });

  it("reads back the state of a submitted job", async () => {
    const job = await printPdf(makePdf({ pages: 1 }), {
      printer,
      jobName: "e2e-status",
      ...(isWindows ? { windows: { outputFile: join(workDir, "status.pdf") } } : {}),
    });

    // The job may already have finished and left the queue, which is a valid
    // outcome; what matters is that a lookup either describes it or says it is
    // gone, rather than failing.
    const status = await getJob(printer, job.jobId);
    if (status !== null) {
      assert.equal(status.jobId, job.jobId);
      assert.ok(
        ["pending", "held", "processing", "stopped", "completed", "unknown"].includes(
          status.state,
        ),
        `unexpected state ${status.state}`,
      );
    }
  });

  it("reports null for a job id that was never issued", async () => {
    assert.equal(await getJob(printer, 999_999), null);
  });

  it("rejects printing to a queue that does not exist", async () => {
    await assert.rejects(
      printPdf(makePdf(), { printer: "print-it-now-no-such-queue" }),
      { code: "EPRINTERNOTFOUND" },
    );
  });

  it("rejects data that is not a PDF, before anything is queued", async () => {
    // CUPS trusts the document format a client declares and only aborts the job
    // later during filtering, so without the header check in printPdf this would
    // silently look like a success on Linux and a failure on Windows.
    await assert.rejects(printPdf(Buffer.from("this is definitely not a PDF"), { printer }), {
      code: "EINVALIDPDF",
    });
  });

  it("rejects a file that is not a PDF", async () => {
    const path = join(workDir, "not-a-pdf.txt");
    await writeFile(path, "PK\u0003\u0004 this is a zip, not a PDF");
    await assert.rejects(printPdf(path, { printer }), { code: "EINVALIDPDF" });
  });

  it("rejects a file that does not exist, naming it", async () => {
    await assert.rejects(printPdf(join(workDir, "absent.pdf"), { printer }), {
      code: "EINVALIDPDF",
    });
  });

  it("cancels a job", async () => {
    const job = await printPdf(makePdf({ pages: 40 }), {
      printer,
      jobName: "e2e-cancel",
      ...(isWindows ? { windows: { outputFile: join(workDir, "cancel.pdf") } } : {}),
    });

    // A short job can complete before the cancel lands, in which case the queue
    // rightly reports there is nothing left to cancel.
    try {
      await cancelJob(printer, job.jobId);
    } catch (error) {
      assert.equal(error.code, "EJOBNOTFOUND", `unexpected failure: ${error.message}`);
    }
  });
});
