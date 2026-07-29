/**
 * Anything that can be handed to {@link printPdf} as the document to print.
 *
 * A `string` is treated as a filesystem path. Binary input is sent straight to
 * the printing subsystem without ever being written to a temporary file.
 */
export type PdfSource = string | Buffer | Uint8Array | ArrayBuffer;

/**
 * Channel order of a {@link BitmapSource}'s pixel buffer.
 *
 * - `rgba`: red, green, blue, alpha — the usual layout from canvas and most JS
 *   image libraries.
 * - `bgra`: blue, green, red, alpha — Windows DIB order.
 */
export type BitmapPixelFormat = "rgba" | "bgra";

/**
 * A raw pixel buffer to hand to {@link printBitmap}.
 *
 * `data` must contain exactly `width * height * 4` bytes. Alpha is composited
 * onto white before printing; there is no separate background colour.
 */
export interface BitmapSource {
  width: number;
  height: number;
  data: Buffer | Uint8Array | ArrayBuffer;
  /** Defaults to `rgba`. */
  format?: BitmapPixelFormat;
}

/** Which side(s) of the sheet to print on. */
export type Duplex = "simplex" | "long-edge" | "short-edge";

/** Page orientation on the sheet. */
export type Orientation = "portrait" | "landscape";

/** Colour handling. `auto` leaves the decision to the driver. */
export type ColorMode = "color" | "monochrome" | "auto";

/** Requested output quality. */
export type Quality = "draft" | "normal" | "high";

/**
 * How the PDF page is mapped onto the sheet.
 *
 * - `actual`: 100% of the PDF's own page size, centred on the sheet.
 * - `fit`: scaled up or down so the whole page fits the printable area.
 * - `shrink`: like `fit`, but never scales up (the usual viewer default).
 * - `noscale-clip`: 100%, anchored at the printable origin, overflow clipped.
 */
export type ScaleMode = "actual" | "fit" | "shrink" | "noscale-clip";

/** Restrict a job to only the odd or only the even pages of its selection. */
export type PageSubset = "all" | "odd" | "even";

/**
 * How the Windows backend gets rasterised or vector content onto the printer
 * device context.
 *
 * - `vector` renders through PDFium's Windows print device, producing EMF or
 *   PostScript. Output is small and text stays sharp at the device's native
 *   resolution.
 * - `bitmap` rasterises each page to a DIB and blits it. Slower and larger, but
 *   it is the reliable choice for drivers that mishandle EMF records.
 */
export type WindowsRenderMode = "vector" | "bitmap";

/**
 * PDFium's Windows print mode, forwarded to `FPDF_SetPrintMode`. Only
 * meaningful when {@link WindowsRenderMode} is `vector`.
 */
export type WindowsPrintMode =
  | "emf"
  | "text-only"
  | "postscript2"
  | "postscript3"
  | "postscript2-passthrough"
  | "postscript3-passthrough"
  | "emf-image-masks"
  | "postscript3-type42"
  | "postscript3-type42-passthrough";

/** Windows-only knobs. Ignored on macOS and Linux. */
export interface WindowsOptions {
  /** Defaults to `vector`. */
  renderMode?: WindowsRenderMode;
  /** Defaults to `emf`. Only used when `renderMode` is `vector`. */
  printMode?: WindowsPrintMode;
  /**
   * Redirect the spooled output to a file instead of the device. Required for
   * file-backed drivers such as "Microsoft Print to PDF", which would otherwise
   * pop a save dialog and defeat the point of a headless API.
   */
  outputFile?: string;
}

export interface PaperSizeMm {
  widthMm: number;
  heightMm: number;
}

/**
 * A named paper size (`"A4"`, `"Letter"`, `"Legal"`, …) or explicit dimensions
 * in millimetres.
 *
 * Named sizes are resolved to a Windows `DMPAPER_*` constant on Windows and to
 * a PWG media name on CUPS platforms. Explicit dimensions become a custom
 * `DEVMODE` size or a `custom_…` PWG name respectively.
 */
export type PaperSize = string | PaperSizeMm;

export interface PrintOptions {
  /**
   * Destination queue name. Defaults to the system default printer; if there is
   * no default, {@link printPdf} rejects with a `NoPrinterError`.
   */
  printer?: string;
  /** Job title shown in the queue. Defaults to the file name, or `"print-it-now"`. */
  jobName?: string;
  /** Number of copies. Must be a positive integer. Defaults to 1. */
  copies?: number;
  /** Collate multi-page copies. Defaults to `true` when `copies > 1`. */
  collate?: boolean;
  /**
   * Pages to print, as a 1-based range expression: `"1-3,5,8-"`. An open-ended
   * range runs to the last page. Defaults to the whole document.
   */
  pages?: string;
  /** Narrow the selection to odd or even pages. Defaults to `all`. */
  pageSubset?: PageSubset;
  /** Emit pages last-to-first. Defaults to `false`. */
  reverse?: boolean;
  duplex?: Duplex;
  orientation?: Orientation;
  paperSize?: PaperSize;
  /**
   * Input tray. On Windows this is either a `DMBIN_*` name (`"auto"`, `"upper"`,
   * `"manual"`, …) or a numeric driver-specific bin id; on CUPS it becomes
   * `media-source`.
   */
  tray?: string | number;
  color?: ColorMode;
  quality?: Quality;
  /** Defaults to `shrink`. */
  scale?: ScaleMode;
  /**
   * Resolution in DPI.
   *
   * For {@link printPdf} this is only used by the Windows `bitmap` render mode
   * (defaults to the device's own resolution). For {@link printBitmap} it is
   * the intrinsic resolution of the pixel buffer used for placement (defaults
   * to 72, so one pixel is one PostScript point).
   */
  dpi?: number;
  /** Pages per sheet. Must be one of 1, 2, 4, 6, 9 or 16. Defaults to 1. */
  numberUp?: number;
  /**
   * Extra IPP attributes merged into the CUPS job, e.g.
   * `{ "job-priority": "80" }`. Ignored on Windows.
   */
  ipp?: Record<string, string>;
  windows?: WindowsOptions;
  /**
   * Accept and silently drop options the current platform cannot honour instead
   * of throwing `UnsupportedOptionError`. Defaults to `false`, because quietly
   * printing something other than what was asked for is worse than failing.
   */
  ignoreUnsupportedOptions?: boolean;
}

/**
 * Options accepted by {@link printBitmap}.
 *
 * Page-selection and imposition knobs from {@link PrintOptions} do not apply to
 * a single bitmap, so they are omitted here. Passing them at runtime still
 * rejects with {@link InvalidOptionError}.
 */
export type BitmapPrintOptions = Omit<
  PrintOptions,
  "pages" | "pageSubset" | "reverse" | "numberUp"
>;

/** Lifecycle state of a queued job, normalised across backends. */
export type JobState =
  | "pending"
  | "held"
  | "processing"
  | "stopped"
  | "completed"
  | "canceled"
  | "aborted"
  | "unknown";

export interface PrintJob {
  /** Backend job id: a CUPS job id, or a Windows spooler job id. */
  jobId: number;
  /** The queue the job was actually submitted to. */
  printer: string;
  /** Job title as submitted. */
  jobName: string;
  /**
   * Pages the backend was asked to produce, after range, subset and reverse
   * handling. `undefined` when the backend expands the selection itself (CUPS
   * resolves `page-ranges` server-side, so the count is not known up front).
   */
  pageCount?: number;
}

export interface JobStatus {
  jobId: number;
  printer: string;
  jobName: string;
  state: JobState;
  /** Total pages in the job, when the backend reports it. */
  totalPages?: number;
  /** Pages produced so far, when the backend reports it. */
  pagesPrinted?: number;
  /** Job size in bytes, when the backend reports it. */
  size?: number;
  /** Submission time. */
  createdAt?: Date;
  /** Raw backend state string, useful when `state` is `unknown`. */
  rawState?: string;
}

/** Coarse queue health, normalised across backends. */
export type PrinterState = "idle" | "processing" | "stopped" | "unknown";

export interface Printer {
  /** Queue name, the value to pass as {@link PrintOptions.printer}. */
  name: string;
  /** Human-readable name, when the backend provides one. */
  displayName?: string;
  isDefault: boolean;
  state: PrinterState;
  /** Free-form reason the queue is stopped or in error, when available. */
  stateReason?: string;
  /** Physical location string, when configured. */
  location?: string;
  /** Driver or PPD description, when available. */
  driver?: string;
  /** Device URI (CUPS) or port name (Windows), when available. */
  uri?: string;
  /** Whether the queue currently accepts new jobs. */
  acceptingJobs?: boolean;
}

/** Which native backend is compiled into the loaded addon. */
export type BackendName = "windows" | "cups" | "lp-fallback";

export interface BackendInfo {
  backend: BackendName;
  /** PDFium version string, on Windows. */
  pdfiumVersion?: string;
  /** CUPS library that was resolved at runtime, on POSIX. */
  cupsLibrary?: string;
}
