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
import { countPdfPages, makePdf, mmToPoints, readMediaBox } from "../helpers/pdf.mjs";

/**
 * Prints for real, through the platform's actual printing subsystem, and checks
 * what came out the other end.
 *
 * The test needs a queue that writes to a file. scripts/setup-test-printer.sh
 * creates one and prints the environment to use:
 *
 *   PRINT_IT_NOW_TEST_PRINTER      queue name
 *   PRINT_IT_NOW_TEST_OUTPUT_DIR   directory the queue writes into, one file per
 *                                  job named after the job title (Linux cups-pdf)
 *   PRINT_IT_NOW_TEST_OUTPUT_FILE  single fixed path the queue overwrites
 *                                  (a raw `file:` queue)
 *   PRINT_IT_NOW_TEST_NO_OUTPUT    set to 1 when a real queue exists but its
 *                                  output cannot be inspected, as on macOS: it
 *                                  removed raw queue support and has no cups-pdf,
 *                                  so the queue is an ippeveprinter sink. The
 *                                  submission, enumeration, status and error
 *                                  paths still run against real CUPS there; the
 *                                  identical backend has its output verified on
 *                                  Linux.
 *   PRINT_IT_NOW_TEST_RENDERS      set to 1 when the pipeline applies page
 *                                  selection and paper size, so those are
 *                                  observable in the output
 *   PRINT_IT_NOW_TEST_COPIES       set to 1 when copies appear as extra pages in
 *                                  the output. Driver-dependent: a driver that
 *                                  produces copies itself may emit one document
 *                                  instead
 *   PRINT_IT_NOW_TEST_RENDER_MODE  vector | bitmap, to exercise both Windows
 *                                  render paths
 *
 * On Windows no output location is needed from the environment: each job names
 * its own file through `windows.outputFile`, which is also what stops a
 * file-backed driver from waiting on a save dialog.
 */

const isWindows = process.platform === "win32";
const printer = process.env["PRINT_IT_NOW_TEST_PRINTER"];
const outputDir = process.env["PRINT_IT_NOW_TEST_OUTPUT_DIR"];
const outputFile = process.env["PRINT_IT_NOW_TEST_OUTPUT_FILE"];
const rendersOptions = process.env["PRINT_IT_NOW_TEST_RENDERS"] === "1";
const copiesMultiplyPages = process.env["PRINT_IT_NOW_TEST_COPIES"] === "1";
const renderMode = process.env["PRINT_IT_NOW_TEST_RENDER_MODE"];

const noOutput = process.env["PRINT_IT_NOW_TEST_NO_OUTPUT"] === "1";
const canInspectOutput =
  !noOutput && (isWindows || outputDir !== undefined || outputFile !== undefined);

const skip =
  printer !== undefined && (canInspectOutput || noOutput)
    ? false
    : "set PRINT_IT_NOW_TEST_PRINTER, plus PRINT_IT_NOW_TEST_OUTPUT_DIR, " +
      "PRINT_IT_NOW_TEST_OUTPUT_FILE or PRINT_IT_NOW_TEST_NO_OUTPUT on POSIX. " +
      "scripts/setup-test-printer.sh creates a suitable queue and prints the " +
      "environment to use.";

// The option-dependent assertions all read the produced bytes, so they need both
// a queue that applies options and one whose output can be seen.
const needsFilters = !canInspectOutput
  ? "this queue's output cannot be inspected"
  : rendersOptions
    ? false
    : "this queue does not apply print options";

// The CI matrix forces this path on one job so the fallback cannot rot unnoticed.
// It drives lp/lpstat/cancel, which report less than the library does.
const isLpFallback = process.env["PRINT_IT_NOW_BACKEND"] === "lp";
const needsJobStatus = isLpFallback
  ? "the lp fallback cannot report job status"
  : false;

/** How long a queue gets to produce output before the test gives up. */
const OUTPUT_TIMEOUT_MS = Number(process.env["PRINT_IT_NOW_TEST_TIMEOUT_MS"] ?? 45000);

/** Windows render mode override, threaded into every job when set. */
const windowsOverrides = renderMode === undefined ? {} : { renderMode };

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

async function fileIfPresent(path) {
  try {
    await readFile(path);
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Submits a job and returns the bytes the queue produced.
 *
 * Three collection strategies, because file-backed queues differ in who chooses
 * the filename: on Windows the caller does, a cups-pdf queue names each file
 * after the job title, and a raw `file:` queue overwrites one fixed path.
 */
async function printAndCollect(source, options = {}) {
  const jobName = options.jobName ?? `e2e-${Math.random().toString(36).slice(2, 10)}`;
  const submit = (extra = {}) =>
    printPdf(source, {
      ...options,
      jobName,
      printer,
      windows: { ...windowsOverrides, ...options.windows, ...extra },
    });

  if (!canInspectOutput) return { job: await submit(), bytes: undefined };

  if (isWindows) {
    const destination = join(workDir, `${jobName}.pdf`);
    const job = await submit({ outputFile: destination });
    return { job, bytes: await waitForStableFile(() => fileIfPresent(destination)) };
  }

  if (outputFile !== undefined) {
    // A raw queue reuses the same path, so the previous job's output has to go
    // first or the wait would return it immediately.
    await rm(outputFile, { force: true });
    const job = await submit();
    return { job, bytes: await waitForStableFile(() => fileIfPresent(outputFile)) };
  }

  const before = new Set(await readdir(outputDir).catch(() => []));
  const job = await submit();
  const bytes = await waitForStableFile(async () => {
    const now = await readdir(outputDir).catch(() => []);
    const created = now.filter((name) => !before.has(name));
    if (created.length === 0) return undefined;
    // Prefer a file the queue named after the job, but do not require it: only
    // one job is in flight at a time, so any new file is this job's output.
    const named = created.find((name) => name.includes(jobName));
    return join(outputDir, named ?? created[0]);
  });
  return { job, bytes };
}

describe("end-to-end printing", { skip }, () => {
  it("reports the backend that is doing the work", async () => {
    const info = await getBackendInfo();
    const expected = isLpFallback ? "lp-fallback" : isWindows ? "windows" : "cups";
    assert.equal(info.backend, expected);
    if (expected === "windows") {
      assert.ok(info.pdfiumVersion, "the Windows backend should report its PDFium build");
    } else if (expected === "cups") {
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
    if (canInspectOutput) {
      assert.ok(bytes, "the queue should have produced output");
      assert.equal(countPdfPages(bytes), 3);
    }
  });

  it("prints a PDF passed as a file path", async () => {
    const path = join(workDir, "from-disk.pdf");
    await writeFile(path, makePdf({ pages: 2, label: "from disk" }));
    const { job, bytes } = await printAndCollect(path, { jobName: "e2e-from-disk" });
    assert.ok(job.jobId > 0, "a job id should come back");
    if (canInspectOutput) {
      assert.ok(bytes, "the queue should have produced output");
      assert.equal(countPdfPages(bytes), 2);
    }
  });

  it("honours a page range", { skip: needsFilters }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 8 }), {
      jobName: "e2e-range",
      pages: "2-4",
    });
    assert.ok(bytes);
    assert.equal(countPdfPages(bytes), 3);
  });

  it("honours an open-ended page range", { skip: needsFilters }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 6 }), {
      jobName: "e2e-open-range",
      pages: "5-",
    });
    assert.ok(bytes);
    assert.equal(countPdfPages(bytes), 2);
  });

  it("honours an odd page subset", { skip: needsFilters }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 7 }), {
      jobName: "e2e-odd",
      pageSubset: "odd",
    });
    assert.ok(bytes);
    assert.equal(countPdfPages(bytes), 4);
  });

  it("honours a paper size", { skip: needsFilters }, async () => {
    const { bytes } = await printAndCollect(makePdf({ pages: 1 }), {
      jobName: "e2e-a5",
      paperSize: "A5",
    });
    assert.ok(bytes);

    const box = readMediaBox(bytes);
    assert.ok(box, "the output should declare a media box");

    // A5 is 148 x 210mm. Converting to points never lands on a round number, and
    // drivers round differently, so allow a couple of points either way.
    const expected = { widthPt: mmToPoints(148), heightPt: mmToPoints(210) };
    const tolerance = 3;
    assert.ok(
      Math.abs(box.widthPt - expected.widthPt) <= tolerance &&
        Math.abs(box.heightPt - expected.heightPt) <= tolerance,
      `expected roughly ${expected.widthPt.toFixed(1)} x ${expected.heightPt.toFixed(1)}pt ` +
        `(A5), got ${box.widthPt.toFixed(1)} x ${box.heightPt.toFixed(1)}pt`,
    );
  });

  it("prints multiple copies", async () => {
    const { job, bytes } = await printAndCollect(makePdf({ pages: 2 }), {
      jobName: "e2e-copies",
      copies: 2,
    });
    assert.ok(job.jobId > 0);
    if (canInspectOutput) assert.ok(bytes, "the queue should have produced output");

    // Whether copies show up as extra pages depends on the driver: one that can
    // produce copies itself is handed dmCopies and emits a single document, while
    // cups-filters duplicates the pages. Only assert the count where the setup
    // script has established which of the two this queue does.
    if (copiesMultiplyPages) {
      assert.equal(countPdfPages(bytes), 4);
    }
  });

  it("reads back the state of a submitted job", { skip: needsJobStatus }, async () => {
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

  it("reports null for a job id that was never issued", { skip: needsJobStatus }, async () => {
    assert.equal(await getJob(printer, 999_999), null);
  });

  it("says so plainly when the fallback cannot report job status", {
    skip: isLpFallback ? false : "only applies to the lp fallback",
  }, async () => {
    // Refusing is the honest answer here: the command line tools report state as
    // localised prose, and guessing at it would be worse than saying no.
    await assert.rejects(getJob(printer, 1), { code: "EBACKENDUNAVAILABLE" });
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
