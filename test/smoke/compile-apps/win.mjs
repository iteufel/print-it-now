/**
 * Fixture for `bun build --compile` on Windows.
 *
 * The platform import is the whole point: it is a static `require` of the
 * `.node` file (and `pdfium.dll`) so Bun embeds both. Without it the compiled
 * executable cannot find `prebuilds/`.
 */
import "print-it-now/platform/win";
import { getBackendInfo } from "print-it-now";

const info = await getBackendInfo();
if (typeof info.backend !== "string" || info.backend.length === 0) {
  throw new Error(`expected a backend, got ${JSON.stringify(info)}`);
}
process.stdout.write(`compile-smoke ${JSON.stringify(info)}\n`);
