/**
 * Compile entry that does *not* import a platform entry.
 *
 * The compiled executable must not find `prebuilds/` on disk. `loadNative`
 * is the seam: on POSIX, `getBackendInfo()` would hide a missing addon by
 * falling back to `lp`.
 */

import { loadNative } from "../../../src/internal.js";
import { BackendUnavailableError } from "../../../src/errors.js";

let thrown: unknown;
try {
  loadNative();
} catch (error) {
  thrown = error;
}

if (thrown === undefined) {
  throw new Error(
    "loadNative() succeeded without a print-it-now/platform import; the addon was not supposed to be embedded",
  );
}

if (!(thrown instanceof BackendUnavailableError) || thrown.code !== "EBACKENDUNAVAILABLE") {
  throw new Error(`expected EBACKENDUNAVAILABLE, got ${String(thrown)}`);
}

if (!/print-it-now\/platform/.test(thrown.message)) {
  throw new Error(
    `expected the message to tell the caller to import print-it-now/platform, got: ${thrown.message}`,
  );
}

process.stdout.write("without-platform-ok\n");
