import { InvalidOptionError, UnsupportedOptionError } from "./errors.js";
import { OPEN_ENDED, parsePageRanges, toIppPageRanges, type PageRange } from "./pages.js";
import {
  DMPAPER_USER,
  customMediaName,
  findPaperBin,
  findPaperSize,
  knownPaperBinNames,
  knownPaperSizeNames,
  toTenthsOfMm,
} from "./paper.js";
import type {
  BackendName,
  BitmapPixelFormat,
  BitmapPrintOptions,
  BitmapSource,
  ColorMode,
  Duplex,
  Orientation,
  PageSubset,
  PaperSize,
  PrintOptions,
  Quality,
  ScaleMode,
  WindowsPrintMode,
  WindowsRenderMode,
} from "./types.js";

/** Numeric encodings shared with native/src/convert.cc. */
export const DOCUMENT_KIND_CODE = { pdf: 0, bitmap: 1 } as const;
export const PIXEL_FORMAT_CODE: Record<BitmapPixelFormat, number> = { rgba: 0, bgra: 1 };
export const SUBSET_CODE: Record<PageSubset, number> = { all: 0, odd: 1, even: 2 };
export const SCALE_CODE: Record<ScaleMode, number> = {
  actual: 0,
  fit: 1,
  shrink: 2,
  "noscale-clip": 3,
};
export const RENDER_MODE_CODE: Record<WindowsRenderMode, number> = { vector: 0, bitmap: 1 };

/** `FPDF_PRINTMODE_*`, from PDFium's fpdf_edit.h. */
export const PRINT_MODE_CODE: Record<WindowsPrintMode, number> = {
  emf: 0,
  "text-only": 1,
  postscript2: 2,
  postscript3: 3,
  "postscript2-passthrough": 4,
  "postscript3-passthrough": 5,
  "emf-image-masks": 6,
  "postscript3-type42": 7,
  "postscript3-type42-passthrough": 8,
};

/** DEVMODE constants. */
const DMORIENT: Record<Orientation, number> = { portrait: 1, landscape: 2 };
const DMDUP: Record<Duplex, number> = { simplex: 1, "long-edge": 2, "short-edge": 3 };
const DMCOLOR = { monochrome: 1, color: 2 } as const;
// DMRES_DRAFT, DMRES_MEDIUM and DMRES_HIGH; the values are negative by design,
// which is how a driver tells a quality band apart from a literal DPI.
const DMRES: Record<Quality, number> = { draft: -1, normal: -3, high: -4 };
const DMCOLLATE = { false: 0, true: 1 } as const;

/** IPP `print-quality` enum values. */
const IPP_QUALITY: Record<Quality, string> = { draft: "3", normal: "4", high: "5" };
/** IPP `orientation-requested` enum values. */
const IPP_ORIENTATION: Record<Orientation, string> = { portrait: "3", landscape: "4" };
const IPP_SIDES: Record<Duplex, string> = {
  simplex: "one-sided",
  "long-edge": "two-sided-long-edge",
  "short-edge": "two-sided-short-edge",
};

const VALID_NUMBER_UP = [1, 2, 4, 6, 9, 16];

/**
 * A fully validated set of options: every field is present, in range, and free
 * of the ambiguity the public {@link PrintOptions} allows. Splitting validation
 * from backend mapping keeps both halves testable without a printer.
 */
export interface ResolvedOptions {
  printer?: string;
  jobName?: string;
  copies: number;
  collate: boolean;
  ranges: PageRange[];
  subset: PageSubset;
  reverse: boolean;
  duplex?: Duplex;
  orientation?: Orientation;
  paperSize?: PaperSize;
  tray?: string | number;
  color?: ColorMode;
  quality?: Quality;
  scale: ScaleMode;
  dpi?: number;
  numberUp: number;
  ipp: Record<string, string>;
  windows: {
    renderMode: WindowsRenderMode;
    printMode: WindowsPrintMode;
    outputFile?: string;
  };
  ignoreUnsupportedOptions: boolean;
}

function requirePositiveInteger(option: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidOptionError(option, `expected a positive integer, got ${String(value)}`);
  }
  return value;
}

function requireOneOf<T extends string>(option: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InvalidOptionError(
      option,
      `expected one of ${allowed.map((entry) => `"${entry}"`).join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  return value as T;
}

function validatePaperSize(value: PaperSize): PaperSize {
  if (typeof value === "string") {
    if (findPaperSize(value)) return value;
    throw new InvalidOptionError(
      "paperSize",
      `"${value}" is not a known paper size. Known names: ${knownPaperSizeNames().join(", ")}. ` +
        "Alternatively pass explicit dimensions as { widthMm, heightMm }.",
    );
  }

  if (typeof value !== "object" || value === null) {
    throw new InvalidOptionError("paperSize", `expected a name or { widthMm, heightMm }`);
  }
  for (const key of ["widthMm", "heightMm"] as const) {
    const dimension = value[key];
    if (typeof dimension !== "number" || !Number.isFinite(dimension) || dimension <= 0) {
      throw new InvalidOptionError("paperSize", `${key} must be a positive number`);
    }
    // DEVMODE stores tenths of a millimetre in a signed 16-bit field.
    if (toTenthsOfMm(dimension) > 32767) {
      throw new InvalidOptionError(
        "paperSize",
        `${key} of ${dimension}mm exceeds the 3276.7mm maximum a printer driver can be told about`,
      );
    }
  }
  return value;
}

function validateTray(value: string | number): string | number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 32767) {
      throw new InvalidOptionError(
        "tray",
        "a numeric tray must be a driver bin id between 1 and 32767",
      );
    }
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidOptionError("tray", "expected a tray name or a numeric driver bin id");
  }
  return value;
}

/** Validates and fills in defaults. Throws {@link InvalidOptionError} on bad input. */
export function resolveOptions(options: PrintOptions = {}): ResolvedOptions {
  if (typeof options !== "object" || options === null) {
    throw new InvalidOptionError("options", "expected an object");
  }

  if (options.printer !== undefined && typeof options.printer !== "string") {
    throw new InvalidOptionError("printer", "expected a printer name");
  }
  if (options.printer !== undefined && options.printer.trim() === "") {
    throw new InvalidOptionError("printer", "the printer name is empty");
  }
  if (options.jobName !== undefined && typeof options.jobName !== "string") {
    throw new InvalidOptionError("jobName", "expected a string");
  }

  const copies = options.copies === undefined ? 1 : requirePositiveInteger("copies", options.copies);
  if (options.collate !== undefined && typeof options.collate !== "boolean") {
    throw new InvalidOptionError("collate", "expected a boolean");
  }
  if (options.reverse !== undefined && typeof options.reverse !== "boolean") {
    throw new InvalidOptionError("reverse", "expected a boolean");
  }

  const numberUp = options.numberUp ?? 1;
  if (!VALID_NUMBER_UP.includes(numberUp)) {
    throw new InvalidOptionError(
      "numberUp",
      `expected one of ${VALID_NUMBER_UP.join(", ")}, got ${String(options.numberUp)}`,
    );
  }

  if (options.dpi !== undefined) {
    if (!Number.isInteger(options.dpi) || options.dpi < 30 || options.dpi > 4800) {
      throw new InvalidOptionError("dpi", "expected an integer between 30 and 4800");
    }
  }

  if (options.ipp !== undefined) {
    if (typeof options.ipp !== "object" || options.ipp === null || Array.isArray(options.ipp)) {
      throw new InvalidOptionError("ipp", "expected an object of attribute name to value");
    }
    for (const [key, value] of Object.entries(options.ipp)) {
      if (typeof value !== "string") {
        throw new InvalidOptionError("ipp", `the value of "${key}" must be a string`);
      }
    }
  }

  const windows = options.windows ?? {};
  if (typeof windows !== "object" || windows === null) {
    throw new InvalidOptionError("windows", "expected an object");
  }

  return {
    ...(options.printer !== undefined ? { printer: options.printer } : {}),
    ...(options.jobName !== undefined ? { jobName: options.jobName } : {}),
    copies,
    // Collating only means anything for multi-page copies, and defaulting it on
    // matches every print dialog.
    collate: options.collate ?? true,
    ranges: options.pages === undefined ? [] : parsePageRanges(options.pages),
    subset:
      options.pageSubset === undefined
        ? "all"
        : requireOneOf("pageSubset", options.pageSubset, ["all", "odd", "even"] as const),
    reverse: options.reverse ?? false,
    ...(options.duplex !== undefined
      ? {
          duplex: requireOneOf("duplex", options.duplex, [
            "simplex",
            "long-edge",
            "short-edge",
          ] as const),
        }
      : {}),
    ...(options.orientation !== undefined
      ? {
          orientation: requireOneOf("orientation", options.orientation, [
            "portrait",
            "landscape",
          ] as const),
        }
      : {}),
    ...(options.paperSize !== undefined
      ? { paperSize: validatePaperSize(options.paperSize) }
      : {}),
    ...(options.tray !== undefined ? { tray: validateTray(options.tray) } : {}),
    ...(options.color !== undefined
      ? { color: requireOneOf("color", options.color, ["color", "monochrome", "auto"] as const) }
      : {}),
    ...(options.quality !== undefined
      ? { quality: requireOneOf("quality", options.quality, ["draft", "normal", "high"] as const) }
      : {}),
    scale:
      options.scale === undefined
        ? "shrink"
        : requireOneOf("scale", options.scale, [
            "actual",
            "fit",
            "shrink",
            "noscale-clip",
          ] as const),
    ...(options.dpi !== undefined ? { dpi: options.dpi } : {}),
    numberUp,
    ipp: { ...(options.ipp ?? {}) },
    windows: {
      renderMode:
        windows.renderMode === undefined
          ? "vector"
          : requireOneOf("windows.renderMode", windows.renderMode, ["vector", "bitmap"] as const),
      printMode:
        windows.printMode === undefined
          ? "emf"
          : requireOneOf(
              "windows.printMode",
              windows.printMode,
              Object.keys(PRINT_MODE_CODE) as WindowsPrintMode[],
            ),
      ...(windows.outputFile !== undefined ? { outputFile: windows.outputFile } : {}),
    },
    ignoreUnsupportedOptions: options.ignoreUnsupportedOptions ?? false,
  };
}

function reject(resolved: ResolvedOptions, option: string, backend: BackendName, hint: string) {
  if (resolved.ignoreUnsupportedOptions) return;
  throw new UnsupportedOptionError(option, backend, hint);
}

/**
 * Maps resolved options onto IPP attributes for the CUPS backend.
 *
 * Caller-supplied `ipp` entries are applied last so an explicit attribute always
 * wins over one this mapping derived, which is what makes the escape hatch
 * useful for queues with unusual vocabularies.
 *
 * @param documentKind Bitmap jobs skip PDF-only attributes (`page-ranges`,
 *   `number-up`, …) and treat `dpi` as the intrinsic image resolution rather
 *   than a Windows-only rasterisation knob.
 */
export function toIppOptions(
  resolved: ResolvedOptions,
  documentKind: "pdf" | "bitmap" = "pdf",
): Array<[string, string]> {
  const attributes = new Map<string, string>();

  if (resolved.copies > 1) {
    attributes.set("copies", String(resolved.copies));
    attributes.set(
      "multiple-document-handling",
      resolved.collate
        ? "separate-documents-collated-copies"
        : "separate-documents-uncollated-copies",
    );
  }
  if (documentKind === "pdf") {
    if (resolved.ranges.length > 0) {
      attributes.set("page-ranges", toIppPageRanges(resolved.ranges));
    }
    if (resolved.subset !== "all") attributes.set("page-set", resolved.subset);
    // CUPS' own attribute; the IPP standard equivalent, page-delivery, is not
    // implemented by cupsd.
    if (resolved.reverse) attributes.set("outputorder", "reverse");
    if (resolved.numberUp > 1) attributes.set("number-up", String(resolved.numberUp));
  }
  if (resolved.duplex) attributes.set("sides", IPP_SIDES[resolved.duplex]);
  if (resolved.orientation) {
    attributes.set("orientation-requested", IPP_ORIENTATION[resolved.orientation]);
  }
  if (resolved.paperSize !== undefined) {
    if (typeof resolved.paperSize === "string") {
      // findPaperSize cannot miss here: resolveOptions already rejected unknown names.
      attributes.set("media", findPaperSize(resolved.paperSize)!.pwg);
    } else {
      attributes.set(
        "media",
        customMediaName(resolved.paperSize.widthMm, resolved.paperSize.heightMm),
      );
    }
  }
  if (resolved.tray !== undefined) attributes.set("media-source", String(resolved.tray));
  if (resolved.color && resolved.color !== "auto") {
    attributes.set("print-color-mode", resolved.color);
  }
  if (resolved.quality) attributes.set("print-quality", IPP_QUALITY[resolved.quality]);

  switch (resolved.scale) {
    case "fit":
      attributes.set("fit-to-page", "true");
      break;
    case "actual":
      attributes.set("fit-to-page", "false");
      break;
    case "shrink":
      // CUPS has no shrink-only mode: fit-to-page scales in both directions.
      // Since `shrink` is this package's default rather than an explicit
      // request, the queue's own scaling policy is left alone instead of
      // forcing behaviour the caller did not ask for.
      break;
    case "noscale-clip":
      reject(
        resolved,
        "scale: 'noscale-clip'",
        "cups",
        "CUPS always centres the page on the sheet, so it cannot anchor output at the " +
          "printable origin. Use 'actual' for unscaled, centred output.",
      );
      attributes.set("fit-to-page", "false");
      break;
  }

  if (documentKind === "pdf" && resolved.dpi !== undefined) {
    reject(
      resolved,
      "dpi",
      "cups",
      "CUPS renders the PDF itself at the queue's resolution. Use `quality`, or pass " +
        "a driver-specific attribute through `ipp`.",
    );
  }

  if (documentKind === "bitmap") {
    // Declaring the format up front keeps filters from sniffing the stream and
    // guessing wrong when the BMP header is still in flight.
    attributes.set("document-format", "image/bmp");
  }

  for (const [key, value] of Object.entries(resolved.ipp)) attributes.set(key, value);
  return [...attributes];
}

export interface WindowsSettings {
  orientation?: number;
  paperSize?: number;
  paperWidth?: number;
  paperLength?: number;
  duplex?: number;
  color?: number;
  quality?: number;
  bin?: number;
  collate?: number;
  renderMode: number;
  printMode: number;
  dpi: number;
  outputFile?: string;
}

/** Maps resolved options onto the DEVMODE values the Windows backend applies. */
export function toWindowsSettings(resolved: ResolvedOptions): WindowsSettings {
  const settings: WindowsSettings = {
    renderMode: RENDER_MODE_CODE[resolved.windows.renderMode],
    printMode: PRINT_MODE_CODE[resolved.windows.printMode],
    // 0 tells the backend to rasterise at the device's own resolution.
    dpi: resolved.dpi ?? 0,
    ...(resolved.windows.outputFile !== undefined
      ? { outputFile: resolved.windows.outputFile }
      : {}),
  };

  if (resolved.orientation) settings.orientation = DMORIENT[resolved.orientation];
  if (resolved.duplex) settings.duplex = DMDUP[resolved.duplex];
  // `auto` means "leave the driver's own setting alone", so it maps to no field.
  if (resolved.color === "color") settings.color = DMCOLOR.color;
  if (resolved.color === "monochrome") settings.color = DMCOLOR.monochrome;
  if (resolved.quality) settings.quality = DMRES[resolved.quality];
  if (resolved.copies > 1) {
    settings.collate = resolved.collate ? DMCOLLATE.true : DMCOLLATE.false;
  }

  if (resolved.paperSize !== undefined) {
    if (typeof resolved.paperSize === "string") {
      const entry = findPaperSize(resolved.paperSize)!;
      if (entry.dm !== undefined) {
        settings.paperSize = entry.dm;
      } else {
        // Windows has no DMPAPER_* constant for this size (A0 and A1), so it is
        // requested by dimension instead.
        settings.paperSize = DMPAPER_USER;
        settings.paperWidth = toTenthsOfMm(entry.widthMm);
        settings.paperLength = toTenthsOfMm(entry.heightMm);
      }
    } else {
      settings.paperSize = DMPAPER_USER;
      settings.paperWidth = toTenthsOfMm(resolved.paperSize.widthMm);
      settings.paperLength = toTenthsOfMm(resolved.paperSize.heightMm);
    }
  }

  if (resolved.tray !== undefined) {
    if (typeof resolved.tray === "number") {
      settings.bin = resolved.tray;
    } else {
      const bin = findPaperBin(resolved.tray);
      if (bin === undefined) {
        throw new InvalidOptionError(
          "tray",
          `"${resolved.tray}" is not a known Windows tray name. Known names: ` +
            `${knownPaperBinNames().join(", ")}. A driver-specific tray can be given as ` +
            "its numeric DMBIN id.",
        );
      }
      settings.bin = bin;
    }
  }

  if (resolved.numberUp > 1) {
    reject(
      resolved,
      "numberUp",
      "windows",
      "Windows drivers expose pages-per-sheet through private driver settings that " +
        "DEVMODE cannot describe portably. Impose the pages into a single PDF before printing.",
    );
  }

  return settings;
}

/** The request object handed to the native addon. Mirrors native/src/convert.cc. */
export interface NativeRequest {
  printer: string;
  jobName: string;
  /** `0` = PDF, `1` = raw bitmap. */
  kind: number;
  filePath?: string;
  data?: Uint8Array;
  bitmapWidth?: number;
  bitmapHeight?: number;
  pixelFormat?: number;
  copies: number;
  collate: boolean;
  ranges: Array<{ from: number; to: number }>;
  subset: number;
  reverse: boolean;
  scale: number;
  numberUp: number;
  ipp: Array<[string, string]>;
  windows: WindowsSettings;
}

/**
 * The native reader always expects a `windows` object, so non-Windows backends
 * get an inert one rather than running the DEVMODE mapping. Running it would
 * report options as unsupported that the active backend handles perfectly well.
 */
function inertWindowsSettings(resolved: ResolvedOptions): WindowsSettings {
  return {
    renderMode: RENDER_MODE_CODE[resolved.windows.renderMode],
    printMode: PRINT_MODE_CODE[resolved.windows.printMode],
    dpi: 0,
  };
}

export function buildNativeRequest(
  resolved: ResolvedOptions,
  printer: string,
  jobName: string,
  source: { filePath?: string; data?: Uint8Array },
  backend: BackendName,
): NativeRequest {
  const isWindows = backend === "windows";
  return {
    printer,
    jobName,
    kind: DOCUMENT_KIND_CODE.pdf,
    ...(source.filePath !== undefined ? { filePath: source.filePath } : {}),
    ...(source.data !== undefined ? { data: source.data } : {}),
    copies: resolved.copies,
    collate: resolved.collate,
    ranges: resolved.ranges.map(({ from, to }) => ({ from, to: to === OPEN_ENDED ? 0 : to })),
    subset: SUBSET_CODE[resolved.subset],
    reverse: resolved.reverse,
    scale: SCALE_CODE[resolved.scale],
    numberUp: resolved.numberUp,
    ipp: isWindows ? [] : toIppOptions(resolved, "pdf"),
    windows: isWindows ? toWindowsSettings(resolved) : inertWindowsSettings(resolved),
  };
}

/**
 * Validates and normalises options for {@link printBitmap}.
 *
 * Defaults `dpi` to 72 (one pixel ≈ one PostScript point) and rejects PDF-only
 * knobs that TypeScript already omits from {@link BitmapPrintOptions}.
 */
export function resolveBitmapOptions(options: BitmapPrintOptions = {}): ResolvedOptions {
  if (typeof options !== "object" || options === null) {
    throw new InvalidOptionError("options", "expected an object");
  }

  const raw = options as PrintOptions & BitmapPrintOptions;
  for (const option of ["pages", "pageSubset", "reverse", "numberUp"] as const) {
    if (raw[option] !== undefined) {
      throw new InvalidOptionError(
        option,
        "is not supported for bitmap printing; a bitmap is always a single page",
      );
    }
  }
  if (raw.windows?.renderMode !== undefined) {
    throw new InvalidOptionError(
      "windows.renderMode",
      "is not supported for bitmap printing; pixels are always blitted as a DIB",
    );
  }
  if (raw.windows?.printMode !== undefined) {
    throw new InvalidOptionError(
      "windows.printMode",
      "is not supported for bitmap printing; there is no PDFium vector path for raw pixels",
    );
  }

  const resolved = resolveOptions(options as PrintOptions);
  return {
    ...resolved,
    // Intrinsic resolution for placement and for the BMP header CUPS receives.
    dpi: resolved.dpi ?? 72,
  };
}

/** Validates a {@link BitmapSource} and returns the normalised pixel buffer. */
export function readBitmapSource(source: BitmapSource): {
  data: Uint8Array;
  width: number;
  height: number;
  format: BitmapPixelFormat;
  defaultJobName: string;
} {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new InvalidOptionError("source", "expected a { width, height, data } bitmap");
  }

  const width = source.width;
  const height = source.height;
  if (typeof width !== "number" || !Number.isInteger(width) || width < 1) {
    throw new InvalidOptionError("source.width", `expected a positive integer, got ${String(width)}`);
  }
  if (typeof height !== "number" || !Number.isInteger(height) || height < 1) {
    throw new InvalidOptionError(
      "source.height",
      `expected a positive integer, got ${String(height)}`,
    );
  }

  const format: BitmapPixelFormat =
    source.format === undefined
      ? "rgba"
      : requireOneOf("source.format", source.format, ["rgba", "bgra"] as const);

  let data: Uint8Array;
  if (source.data instanceof Uint8Array) {
    data = source.data;
  } else if (source.data instanceof ArrayBuffer) {
    data = new Uint8Array(source.data);
  } else {
    throw new InvalidOptionError(
      "source.data",
      "expected a Buffer, Uint8Array or ArrayBuffer",
    );
  }

  const expected = width * height * 4;
  if (data.byteLength !== expected) {
    throw new InvalidOptionError(
      "source.data",
      `expected ${expected} bytes for a ${width}×${height} ${format} bitmap, got ${data.byteLength}`,
    );
  }

  return { data, width, height, format, defaultJobName: "print-it-now" };
}

/** Builds the native request for a raw bitmap job. */
export function buildBitmapNativeRequest(
  resolved: ResolvedOptions,
  printer: string,
  jobName: string,
  bitmap: { data: Uint8Array; width: number; height: number; format: BitmapPixelFormat },
  backend: BackendName,
): NativeRequest {
  const isWindows = backend === "windows";
  const dpi = resolved.dpi ?? 72;

  // CUPS needs the dpi for the BMP header even though DEVMODE mapping is a
  // Windows concern, so the inert settings still carry it for bitmap jobs.
  const windows = isWindows
    ? toWindowsSettings(resolved)
    : { ...inertWindowsSettings(resolved), dpi };

  return {
    printer,
    jobName,
    kind: DOCUMENT_KIND_CODE.bitmap,
    data: bitmap.data,
    bitmapWidth: bitmap.width,
    bitmapHeight: bitmap.height,
    pixelFormat: PIXEL_FORMAT_CODE[bitmap.format],
    copies: resolved.copies,
    collate: resolved.collate,
    ranges: [],
    subset: SUBSET_CODE.all,
    reverse: false,
    scale: SCALE_CODE[resolved.scale],
    numberUp: 1,
    ipp: isWindows ? [] : toIppOptions(resolved, "bitmap"),
    windows,
  };
}
