import { loadNative, type NativeAddon } from "./binding.js";
import { BackendUnavailableError, PrintError, fromNativeError } from "./errors.js";
import * as lp from "./fallback/lp.js";
import type { BackendName } from "./types.js";

/** The implementation that actually works on this machine. */
export interface Backend {
  name: BackendName;
  /** Absent only for the `lp-fallback` backend. */
  native?: NativeAddon;
}

let backendPromise: Promise<Backend> | undefined;

async function detect(): Promise<Backend> {
  const override = process.env["PRINT_IT_NOW_BACKEND"];
  if (override === "lp") {
    if (process.platform === "win32") {
      throw new BackendUnavailableError(
        "PRINT_IT_NOW_BACKEND=lp selects the CUPS command line fallback, which has no " +
          "equivalent on Windows.",
      );
    }
    return { name: "lp-fallback" };
  }

  let nativeError: unknown;
  try {
    const native = loadNative();
    // describe() is the cheapest call that actually reaches the platform's
    // printing subsystem, so it doubles as the probe for whether that subsystem
    // is there at all: on POSIX it resolves the CUPS library, on Windows it
    // loads pdfium.dll.
    const info = await native.describe();
    return { name: info.backend, native };
  } catch (error) {
    nativeError = error;
  }

  // Windows printing has no command line equivalent to fall back to; the spooler
  // is either reachable or it is not.
  if (process.platform === "win32") {
    throw nativeError instanceof PrintError ? nativeError : fromNativeError(nativeError, {});
  }

  if (await lp.isAvailable()) return { name: "lp-fallback" };

  throw nativeError instanceof PrintError
    ? nativeError
    : new BackendUnavailableError(
        "No printing backend is available: the CUPS library could not be loaded and the " +
          "CUPS command line tools are not installed.",
        { cause: nativeError },
      );
}

/**
 * Resolves the backend, once.
 *
 * A successful detection is cached, but a failure is not: a container that gains
 * CUPS after the first call should start working without needing a restart.
 */
export function getBackend(): Promise<Backend> {
  backendPromise ??= detect().catch((error: unknown) => {
    backendPromise = undefined;
    throw error;
  });
  return backendPromise;
}

/** Forces the next {@link getBackend} call to re-detect. For tests. */
export function resetBackendCache(): void {
  backendPromise = undefined;
}
