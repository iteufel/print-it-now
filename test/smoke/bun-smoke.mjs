/**
 * Confirms the package works under Bun as well as Node.
 *
 * Bun implements Node-API from scratch on top of JavaScriptCore rather than V8,
 * so a native addon working under Node proves nothing about Bun. This exercises
 * the parts where the two runtimes could plausibly diverge: loading the `.node`
 * file at all, the AsyncWorker promises the addon returns, and the module-path
 * resolution the binding loader depends on.
 *
 * Deliberately not a printing test -- it has to pass on machines with no printer,
 * including CI runners -- so it stops at "the backend answered".
 *
 * Run with: bun test/smoke/bun-smoke.mjs
 */

import assert from "node:assert/strict";

const runtime = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`;
const failures = [];

async function check(what, fn) {
  try {
    await fn();
    process.stdout.write(`  ok    ${what}\n`);
  } catch (error) {
    failures.push({ what, error });
    process.stdout.write(`  FAIL  ${what}\n        ${error.message}\n`);
  }
}

process.stdout.write(`print-it-now smoke test on ${runtime}\n`);

const pkg = await import("../../dist/index.js");
const internal = await import("../../dist/internal.js");

await check("the package imports as ESM", () => {
  assert.equal(typeof pkg.printPdf, "function");
  assert.equal(typeof pkg.listPrinters, "function");
});

await check("the native addon loads", () => {
  const native = internal.loadNative();
  assert.equal(typeof native.print, "function");
  assert.equal(typeof native.describe, "function");
});

await check("native synchronous calls work", () => {
  const native = internal.loadNative();
  // Exercises argument marshalling and array construction across the Node-API
  // boundary without needing a printer.
  assert.deepEqual(native._expandPageSelection([{ from: 2, to: 4 }], 0, false, 10), [2, 3, 4]);
  const placement = native._computePlacement(
    612,
    792,
    { dpiX: 300, dpiY: 300, printableWidth: 2450, printableHeight: 3200 },
    1,
  );
  assert.equal(placement.width, 2450);
});

await check("promises returned by AsyncWorker resolve", async () => {
  // The riskiest part under Bun: the addon resolves a Deferred from a libuv
  // worker thread, which relies on Bun's own microtask and threadsafe-function
  // plumbing.
  const info = await pkg.getBackendInfo();
  assert.ok(typeof info.backend === "string" && info.backend.length > 0);
  process.stdout.write(`        backend: ${JSON.stringify(info)}\n`);
});

await check("printer enumeration returns an array", async () => {
  const printers = await pkg.listPrinters();
  assert.ok(Array.isArray(printers));
  process.stdout.write(`        ${printers.length} printer(s)\n`);
});

await check("errors cross the boundary with their code intact", async () => {
  await assert.rejects(pkg.printPdf(Buffer.from("not a pdf")), (error) => {
    assert.equal(error.code, "EINVALIDPDF");
    assert.ok(error instanceof Error);
    return true;
  });
});

await check("option validation behaves identically", () => {
  assert.throws(() => internal.resolveOptions({ copies: 0 }), { code: "EINVALIDOPTION" });
  assert.deepEqual(internal.parsePageRanges("1-3"), [{ from: 1, to: 3 }]);
});

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed on ${runtime}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll checks passed on ${runtime}\n`);
