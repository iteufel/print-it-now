/**
 * Test-only entry point.
 *
 * These are the pure pieces of the package -- option validation, the two backend
 * mappings, page range parsing -- plus the hooks the end-to-end tests need. They
 * are imported by the test suite from this file. It is deliberately left out
 * of package.json's `exports`, so it never becomes part of the supported API.
 */

export { resetBackendCache, getBackend } from "./backend.js";
export { loadNative, isNativeAvailable, registerNative, resetNativeCache } from "./binding.js";
export {
  DOCUMENT_KIND_CODE,
  PIXEL_FORMAT_CODE,
  PRINT_MODE_CODE,
  RENDER_MODE_CODE,
  SCALE_CODE,
  SUBSET_CODE,
  buildBitmapNativeRequest,
  buildNativeRequest,
  readBitmapSource,
  resolveBitmapOptions,
  resolveOptions,
  toIppOptions,
  toWindowsSettings,
  type NativeRequest,
  type ResolvedOptions,
  type WindowsSettings,
} from "./options.js";
export { OPEN_ENDED, parsePageRanges, toIppPageRanges, type PageRange } from "./pages.js";
export {
  DMPAPER_USER,
  customMediaName,
  findPaperBin,
  findPaperSize,
  knownPaperBinNames,
  knownPaperSizeNames,
  paperBinName,
  toTenthsOfMm,
} from "./paper.js";
export * as lpFallback from "./fallback/lp.js";
export { encodeBmp } from "./fallback/bmp.js";
