/**
 * Test-only entry point.
 *
 * These are the pure pieces of the package -- option validation, the two backend
 * mappings, page range parsing -- plus the hooks the end-to-end tests need. They
 * are built into `dist/internal.js` but deliberately left out of package.json's
 * `exports`, so they are reachable from the test suite without becoming part of
 * the supported API.
 */

export { resetBackendCache, getBackend } from "./backend.js";
export { loadNative, isNativeAvailable } from "./binding.js";
export {
  PRINT_MODE_CODE,
  RENDER_MODE_CODE,
  SCALE_CODE,
  SUBSET_CODE,
  buildNativeRequest,
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
  toTenthsOfMm,
} from "./paper.js";
export * as lpFallback from "./fallback/lp.js";
