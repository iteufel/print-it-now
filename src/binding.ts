import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BackendUnavailableError } from "./errors.js";
import type { BackendInfo, JobStatus, Printer } from "./types.js";
import type { NativeRequest } from "./options.js";

/** The addon's exported surface. Mirrors native/src/addon.cc. */
export interface NativeAddon {
  describe(): Promise<BackendInfo>;
  listPrinters(): Promise<Printer[]>;
  defaultPrinter(): Promise<string | null>;
  print(request: NativeRequest): Promise<{
    jobId: number;
    printer: string;
    jobName: string;
    pageCount?: number;
  }>;
  getJob(
    printer: string,
    jobId: number,
  ): Promise<(Omit<JobStatus, "createdAt"> & { createdAt?: number }) | null>;
  listJobs(
    printer: string,
  ): Promise<Array<Omit<JobStatus, "createdAt"> & { createdAt?: number }>>;
  cancelJob(printer: string, jobId: number): Promise<void>;

  /** Test-only hooks; see native/src/addon.cc. */
  _expandPageSelection(
    ranges: Array<{ from: number; to: number }>,
    subset: number,
    reverse: boolean,
    pageCount: number,
  ): number[];
  _computePlacement(
    pageWidthPt: number,
    pageHeightPt: number,
    sheet: Record<string, number>,
    scale: number,
    autoRotate?: boolean,
  ): { x: number; y: number; width: number; height: number; rotate: number };
}

// tsup's `shims` option gives both the ESM and the CJS build a working
// `__dirname`, so the same source locates the addon in either module system.
const require_ = createRequire(join(__dirname, "index.js"));

let cached: NativeAddon | undefined;
let loadFailure: Error | undefined;

/**
 * Loads the native addon, preferring a prebuilt binary.
 *
 * `node-gyp-build` resolves `prebuilds/<platform>-<arch>/` first and falls back
 * to a local `build/Release` from a source build, which is also the layout Bun
 * understands.
 */
export function loadNative(): NativeAddon {
  if (cached) return cached;
  if (loadFailure) throw loadFailure;

  try {
    const load = require_("node-gyp-build") as (root: string) => NativeAddon;
    // The package root is one level up from dist/.
    cached = load(dirname(__dirname));
    return cached;
  } catch (cause) {
    loadFailure = new BackendUnavailableError(
      "The print-it-now native addon could not be loaded. No prebuilt binary matched " +
        `${process.platform}-${process.arch}, and building from source did not produce one. ` +
        "Run `npm rebuild print-it-now --build-from-source` with a C++ toolchain installed, " +
        "or open an issue with your platform and architecture.",
      { cause },
    );
    throw loadFailure;
  }
}

/** Whether the addon is loadable, without throwing. Used to pick a fallback path. */
export function isNativeAvailable(): boolean {
  try {
    loadNative();
    return true;
  } catch {
    return false;
  }
}
