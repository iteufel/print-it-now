import { open, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

import { getBackend } from "./backend.js";
import {
  BackendUnavailableError,
  InvalidOptionError,
  InvalidPdfError,
  JobNotFoundError,
  NoPrinterError,
  PrintError,
  fromNativeError,
} from "./errors.js";
import { encodeBmp } from "./fallback/bmp.js";
import * as lp from "./fallback/lp.js";
import {
  buildBitmapNativeRequest,
  buildNativeRequest,
  readBitmapSource,
  resolveBitmapOptions,
  resolveOptions,
} from "./options.js";
import type {
  BackendInfo,
  BitmapPrintOptions,
  BitmapSource,
  JobStatus,
  PdfSource,
  Printer,
  PrintJob,
  PrintOptions,
} from "./types.js";

export * from "./types.js";
export {
  BackendError,
  BackendUnavailableError,
  InvalidOptionError,
  InvalidPdfError,
  JobNotFoundError,
  NoPrinterError,
  PrintError,
  PrinterNotFoundError,
  UnsupportedOptionError,
  type PrintErrorCode,
} from "./errors.js";
export { parsePageRanges, type PageRange } from "./pages.js";
export { knownPaperSizeNames } from "./paper.js";

/**
 * Which backend is in use and what it is built on.
 *
 * Worth including in a bug report: it distinguishes the CUPS library path from
 * the command line fallback, and reports the PDFium build on Windows.
 */
export async function getBackendInfo(): Promise<BackendInfo> {
  const backend = await getBackend();
  if (backend.native) return backend.native.describe();
  return { backend: backend.name };
}

/** Lists the print queues this machine can submit to. */
export async function listPrinters(): Promise<Printer[]> {
  const backend = await getBackend();
  try {
    return backend.native ? await backend.native.listPrinters() : await lp.listPrinters();
  } catch (error) {
    throw fromNativeError(error, {});
  }
}

/** The system default printer, or `null` when none is configured. */
export async function getDefaultPrinter(): Promise<Printer | null> {
  const backend = await getBackend();
  let name: string | null;
  try {
    name = backend.native ? await backend.native.defaultPrinter() : await lp.getDefaultPrinter();
  } catch (error) {
    throw fromNativeError(error, {});
  }
  if (name === null) return null;

  // The full record is returned rather than just the name so a caller can check
  // the queue's state before printing without a second round trip.
  const printers = await listPrinters();
  return (
    printers.find((printer) => printer.name === name) ?? {
      name,
      isDefault: true,
      state: "unknown",
    }
  );
}

/**
 * Bytes a PDF must start with. The specification allows leading junk, and
 * readers are expected to tolerate it, so the marker is searched for within the
 * first kilobyte rather than required at offset zero.
 */
const PDF_HEADER = "%PDF-";
const PDF_HEADER_SEARCH_BYTES = 1024;

/**
 * Checks the file really looks like a PDF.
 *
 * Worth doing in JS even though both backends would eventually notice, because
 * they notice at different times: PDFium fails synchronously on Windows, while
 * CUPS trusts the document format the client declares and only aborts the job
 * later, during filtering. Without this check, printing an HTML error page that
 * a download silently produced would look like a success on Linux and a failure
 * on Windows.
 */
function assertLooksLikePdf(head: Uint8Array, describe: string): void {
  const text = Buffer.from(
    head.subarray(0, Math.min(head.byteLength, PDF_HEADER_SEARCH_BYTES)),
  ).toString("latin1");
  if (text.includes(PDF_HEADER)) return;
  throw new InvalidPdfError(
    `${describe} does not look like a PDF: no "${PDF_HEADER}" marker in the first ` +
      `${PDF_HEADER_SEARCH_BYTES} bytes. This package prints PDF only; convert other ` +
      "formats first.",
  );
}

async function readSource(source: PdfSource): Promise<{
  filePath?: string;
  data?: Uint8Array;
  defaultJobName: string;
}> {
  if (typeof source === "string") {
    if (source.trim() === "") {
      throw new InvalidOptionError("source", "the file path is empty");
    }

    // Only the header is read here. Passing the path down rather than the bytes
    // lets the backend stream the file, so a large PDF never has to sit in the
    // JS heap.
    let handle: FileHandle | undefined;
    try {
      handle = await open(source, "r");
      const head = Buffer.alloc(PDF_HEADER_SEARCH_BYTES);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      if (bytesRead === 0) {
        throw new InvalidPdfError(`"${source}" is empty`);
      }
      assertLooksLikePdf(head.subarray(0, bytesRead), `"${source}"`);
    } catch (error) {
      if (error instanceof PrintError) throw error;
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        throw new InvalidPdfError(`"${source}" does not exist`, { cause: error });
      }
      throw new InvalidPdfError(`Could not read "${source}": ${errno.message}`, { cause: error });
    } finally {
      await handle?.close();
    }

    return { filePath: source, defaultJobName: basename(source) };
  }

  let data: Uint8Array;
  if (source instanceof Uint8Array) {
    data = source;
  } else if (source instanceof ArrayBuffer) {
    data = new Uint8Array(source);
  } else {
    throw new InvalidOptionError(
      "source",
      "expected a file path, Buffer, Uint8Array or ArrayBuffer",
    );
  }

  if (data.byteLength === 0) {
    throw new InvalidOptionError("source", "the PDF data is empty");
  }
  assertLooksLikePdf(data, "the supplied data");
  return { data, defaultJobName: "print-it-now" };
}

async function resolvePrinter(requested: string | undefined): Promise<string> {
  if (requested !== undefined) return requested;

  const backend = await getBackend();
  const name = backend.native
    ? await backend.native.defaultPrinter()
    : await lp.getDefaultPrinter();
  if (name === null) throw new NoPrinterError();
  return name;
}

/**
 * Prints a PDF, headlessly: no dialog, no viewer, no user present.
 *
 * Resolves once the printing subsystem has accepted the job, which is not the
 * same as once it has reached paper. Poll {@link getJob} for that.
 *
 * @param source A file path, or the PDF bytes. Bytes are handed straight to the
 *   printing subsystem and never staged through a temporary file.
 */
export async function printPdf(source: PdfSource, options: PrintOptions = {}): Promise<PrintJob> {
  const resolved = resolveOptions(options);
  const { filePath, data, defaultJobName } = await readSource(source);
  const backend = await getBackend();
  const printer = await resolvePrinter(resolved.printer);
  const jobName = resolved.jobName ?? defaultJobName;

  const request = buildNativeRequest(
    resolved,
    printer,
    jobName,
    { ...(filePath !== undefined ? { filePath } : {}), ...(data !== undefined ? { data } : {}) },
    backend.name,
  );

  try {
    if (!backend.native) return await lp.print(request);

    const result = await backend.native.print(request);
    return {
      jobId: result.jobId,
      printer: result.printer,
      jobName: result.jobName,
      ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
    };
  } catch (error) {
    throw fromNativeError(error, { printer });
  }
}

/**
 * Prints a raw pixel buffer, headlessly: no dialog, no viewer, no user present.
 *
 * On Windows the pixels are blitted straight onto a printer device context. On
 * macOS and Linux they are wrapped in an in-memory BMP and handed to CUPS as
 * `image/bmp`, so nothing is staged through a temporary file either way.
 *
 * Resolves once the printing subsystem has accepted the job, which is not the
 * same as once it has reached paper. Poll {@link getJob} for that.
 *
 * @param source Width, height and tightly packed 4-byte pixels (`rgba` by
 *   default). Alpha is composited onto white.
 */
export async function printBitmap(
  source: BitmapSource,
  options: BitmapPrintOptions = {},
): Promise<PrintJob> {
  const resolved = resolveBitmapOptions(options);
  const bitmap = readBitmapSource(source);
  const backend = await getBackend();
  const printer = await resolvePrinter(resolved.printer);
  const jobName = resolved.jobName ?? bitmap.defaultJobName;

  const request = buildBitmapNativeRequest(
    resolved,
    printer,
    jobName,
    {
      data: bitmap.data,
      width: bitmap.width,
      height: bitmap.height,
      format: bitmap.format,
    },
    backend.name,
  );

  try {
    if (!backend.native) {
      // The native CUPS path encodes the BMP itself; the command-line fallback
      // has to do it here so `lp` receives a document it knows how to filter.
      const bmp = encodeBmp(
        bitmap.width,
        bitmap.height,
        bitmap.data,
        bitmap.format,
        resolved.dpi ?? 72,
      );
      return await lp.print({ ...request, data: bmp });
    }

    const result = await backend.native.print(request);
    return {
      jobId: result.jobId,
      printer: result.printer,
      jobName: result.jobName,
      ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
    };
  } catch (error) {
    throw fromNativeError(error, { printer });
  }
}

/**
 * Reads back the state of a submitted job, or `null` once it has left the queue.
 *
 * Finished jobs disappear from the queue on both platforms, so `null` means "no
 * longer pending" rather than "never existed".
 */
export async function getJob(printer: string, jobId: number): Promise<JobStatus | null> {
  if (typeof printer !== "string" || printer.trim() === "") {
    throw new InvalidOptionError("printer", "expected a printer name");
  }
  if (!Number.isInteger(jobId)) {
    throw new InvalidOptionError("jobId", "expected an integer job id");
  }

  const backend = await getBackend();
  if (!backend.native) {
    throw new BackendUnavailableError(
      "Job status is not available through the CUPS command line fallback, which reports it " +
        "only as localised prose. Install the CUPS library (libcups2) to read job status.",
    );
  }

  let raw;
  try {
    raw = await backend.native.getJob(printer, jobId);
  } catch (error) {
    throw fromNativeError(error, { printer });
  }
  if (raw === null) return null;

  const { createdAt, ...rest } = raw;
  return {
    ...rest,
    // The native layer reports seconds since the epoch; a Date is friendlier.
    ...(createdAt !== undefined ? { createdAt: new Date(createdAt * 1000) } : {}),
  };
}

/** Cancels a queued or printing job. */
export async function cancelJob(printer: string, jobId: number): Promise<void> {
  if (typeof printer !== "string" || printer.trim() === "") {
    throw new InvalidOptionError("printer", "expected a printer name");
  }
  if (!Number.isInteger(jobId)) {
    throw new InvalidOptionError("jobId", "expected an integer job id");
  }

  const backend = await getBackend();
  try {
    if (backend.native) await backend.native.cancelJob(printer, jobId);
    else await lp.cancelJob(printer, jobId);
  } catch (error) {
    const mapped = fromNativeError(error, { printer });
    // The native layer does not know which job id was asked for, so it is filled
    // in here, where it is known.
    if (mapped instanceof JobNotFoundError) throw new JobNotFoundError(printer, jobId);
    throw mapped;
  }
}
