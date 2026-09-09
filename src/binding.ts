import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackendUnavailableError } from "./errors.js";
import type { BackendInfo, JobStatus, Printer } from "./types.js";
import type { NativeRequest } from "./options.js";

/** Resolve relative to this module, independent of the application's cwd.
 * The CJS build substitutes a runtime __filename URL for import.meta.url.
 * Standalone executables use registration and never call this function.
 */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * `node-gyp-build` lookup, kept opaque so `Bun.build` does not hoist
 * `createRequire(join(packageRoot(), "package.json"))` to module load.
 * That hoist resolves `print-it-now` before a compiled app can use an
 * addon already registered by `print-it-now/platform/*`.
 */
function loadViaNodeGypBuild(): NativeAddon {
  const root = packageRoot();
  const makeRequire: typeof createRequire = createRequire;
  const req = makeRequire(join(root, "package.json"));
  return (req("node-gyp-build") as (dir: string) => NativeAddon)(root);
}

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

/**
 * Shared with `src/platform/*.ts` via `Symbol.for`. A Bun `--compile` build
 * inlines this module into the executable, so a module-local `let cached`
 * would be a different slot from the platform entry that `require`d the
 * `.node` file. The well-known symbol is the one place both sides can meet.
 */
const NATIVE_ADDON = Symbol.for("print-it-now.nativeAddon");
const NATIVE_LOAD_FAILURE = Symbol.for("print-it-now.nativeLoadFailure");

type NativeSlot = NativeAddon | Error | undefined;

function readSlot(key: symbol): NativeSlot {
  return (globalThis as Record<symbol, NativeSlot>)[key];
}

function writeSlot(key: symbol, value: NativeSlot): void {
  (globalThis as Record<symbol, NativeSlot>)[key] = value;
}

function clearSlot(key: symbol): void {
  delete (globalThis as Record<symbol, NativeSlot>)[key];
}

function isBunStandaloneExecutable(): boolean {
  const bun = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun;
  return bun?.isStandaloneExecutable === true;
}

/**
 * Stores an already-loaded addon so {@link loadNative} does not search again.
 *
 * Used by the `print-it-now/platform/*` entries, which statically import the
 * `.node` file with `{ type: "file" }` so `Bun.build({ compile })` embeds it.
 * Also used by tests to inject a fake addon.
 */
export function registerNative(addon: NativeAddon): void {
  writeSlot(NATIVE_ADDON, addon);
  clearSlot(NATIVE_LOAD_FAILURE);
}

/** Clears a loaded addon and a remembered load failure. For tests. */
export function resetNativeCache(): void {
  clearSlot(NATIVE_ADDON);
  clearSlot(NATIVE_LOAD_FAILURE);
}

/**
 * Loads the native addon, preferring a prebuilt binary.
 *
 * A `print-it-now/platform/*` import that already loaded the `.node` file
 * wins, because that is how `bun build --compile` embeds N-API addons.
 * Otherwise `node-gyp-build` resolves `prebuilds/<platform>-<arch>/` and
 * falls back to a local `build/Release` from a source build.
 */
export function loadNative(): NativeAddon {
  const cached = readSlot(NATIVE_ADDON);
  if (cached && !(cached instanceof Error)) return cached;
  const loadFailure = readSlot(NATIVE_LOAD_FAILURE);
  if (loadFailure instanceof Error) throw loadFailure;

  if (isBunStandaloneExecutable()) {
    const failure = new BackendUnavailableError(
      "The print-it-now native addon was not embedded in this executable. " +
        "Import `print-it-now/platform` (or `print-it-now/platform/win`, " +
        "`print-it-now/platform/macos`, or `print-it-now/platform/linux`) " +
        "before compiling with `Bun.build({ compile })`.",
    );
    writeSlot(NATIVE_LOAD_FAILURE, failure);
    throw failure;
  }

  try {
    const addon = loadViaNodeGypBuild();
    writeSlot(NATIVE_ADDON, addon);
    return addon;
  } catch (cause) {
    const failure = new BackendUnavailableError(
      "The print-it-now native addon could not be loaded. No prebuilt binary matched " +
        `${process.platform}-${process.arch}, and building from source did not produce one. ` +
        "Run `npm rebuild print-it-now --build-from-source` with a C++ toolchain installed, " +
        "or open an issue with your platform and architecture.",
      { cause },
    );
    writeSlot(NATIVE_LOAD_FAILURE, failure);
    throw failure;
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
