import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadNative } from "../../dist/internal.js";
import { parsePageRanges } from "../../dist/internal.js";

/**
 * Page expansion happens natively because it needs the document's real page
 * count, which only the renderer knows. It drives the Windows page loop, but the
 * logic itself is platform-independent, so the addon exports it for testing on
 * whatever platform the suite happens to run on.
 */
const native = loadNative();

const SUBSET = { all: 0, odd: 1, even: 2 };

function expand(expression, pageCount, { subset = "all", reverse = false } = {}) {
  const ranges = expression === null ? [] : parsePageRanges(expression);
  return native._expandPageSelection(ranges, SUBSET[subset], reverse, pageCount);
}

describe("native page selection", () => {
  it("expands the whole document when nothing is selected", () => {
    assert.deepEqual(expand(null, 4), [1, 2, 3, 4]);
  });

  it("expands closed ranges", () => {
    assert.deepEqual(expand("2-4", 10), [2, 3, 4]);
  });

  it("resolves an open-ended range against the real page count", () => {
    assert.deepEqual(expand("8-", 10), [8, 9, 10]);
  });

  it("clamps a range that runs past the end of the document", () => {
    // Asking for pages 1-9999 of a three page PDF prints three pages, which is
    // how every viewer behaves; rejecting it would be needlessly strict.
    assert.deepEqual(expand("1-9999", 3), [1, 2, 3]);
  });

  it("drops a range entirely beyond the document", () => {
    assert.deepEqual(expand("50-60", 3), []);
  });

  it("emits each page once and in order, however the ranges were written", () => {
    // Overlapping ranges are far more likely to be a typo than a request for
    // duplicates, and `copies` is the option for wanting more than one.
    assert.deepEqual(expand("5,1-3,2-2", 10), [1, 2, 3, 5]);
  });

  it("narrows a selection to odd pages", () => {
    assert.deepEqual(expand(null, 7, { subset: "odd" }), [1, 3, 5, 7]);
  });

  it("narrows a selection to even pages", () => {
    assert.deepEqual(expand(null, 7, { subset: "even" }), [2, 4, 6]);
  });

  it("applies the subset within an explicit range, not to the whole document", () => {
    assert.deepEqual(expand("4-8", 10, { subset: "even" }), [4, 6, 8]);
  });

  it("reverses after selecting, so the subset is unaffected", () => {
    assert.deepEqual(expand("1-5", 10, { subset: "odd", reverse: true }), [5, 3, 1]);
  });

  it("returns nothing for an empty document rather than misbehaving", () => {
    assert.deepEqual(expand(null, 0), []);
    assert.deepEqual(expand("1-3", 0), []);
  });

  it("handles a single page document", () => {
    assert.deepEqual(expand(null, 1), [1]);
    assert.deepEqual(expand(null, 1, { subset: "even" }), []);
  });
});
