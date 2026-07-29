import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OPEN_ENDED, parsePageRanges, toIppPageRanges } from "../../dist/internal.js";

describe("parsePageRanges", () => {
  it("parses single pages", () => {
    assert.deepEqual(parsePageRanges("5"), [{ from: 5, to: 5 }]);
  });

  it("parses closed ranges", () => {
    assert.deepEqual(parsePageRanges("1-3"), [{ from: 1, to: 3 }]);
  });

  it("parses a mix of pages and ranges", () => {
    assert.deepEqual(parsePageRanges("1-3,5,8-10"), [
      { from: 1, to: 3 },
      { from: 5, to: 5 },
      { from: 8, to: 10 },
    ]);
  });

  it("treats a missing lower bound as page 1", () => {
    assert.deepEqual(parsePageRanges("-4"), [{ from: 1, to: 4 }]);
  });

  it("treats a missing upper bound as the end of the document", () => {
    assert.deepEqual(parsePageRanges("8-"), [{ from: 8, to: OPEN_ENDED }]);
  });

  it("ignores whitespace", () => {
    assert.deepEqual(parsePageRanges("  1 - 3 ,  7  "), [
      { from: 1, to: 3 },
      { from: 7, to: 7 },
    ]);
  });

  it("preserves order and overlap, leaving resolution to the page count", () => {
    // Overlap and descending order are resolved natively against the real page
    // count, so the parser must not quietly normalise them away.
    assert.deepEqual(parsePageRanges("5,1-3,2"), [
      { from: 5, to: 5 },
      { from: 1, to: 3 },
      { from: 2, to: 2 },
    ]);
  });

  for (const [input, reason] of [
    ["", "empty expression"],
    ["   ", "whitespace only"],
    ["1,,3", "empty entry"],
    ["1-2,", "trailing comma"],
    ["abc", "not a number"],
    ["1-a", "malformed upper bound"],
    ["0", "pages start at 1"],
    ["0-3", "lower bound below 1"],
    ["-", "no bounds at all"],
    ["5-2", "ends before it starts"],
    ["1..3", "wrong separator"],
  ]) {
    it(`rejects ${JSON.stringify(input)} (${reason})`, () => {
      assert.throws(() => parsePageRanges(input), { code: "EINVALIDOPTION", option: "pages" });
    });
  }
});

describe("toIppPageRanges", () => {
  it("formats closed ranges", () => {
    assert.equal(toIppPageRanges(parsePageRanges("1-3,5")), "1-3,5-5");
  });

  it("gives an open-ended range IPP's largest page number", () => {
    // IPP has no open-ended form, so the upper bound has to be a number every
    // implementation clamps to the document length.
    assert.equal(toIppPageRanges(parsePageRanges("8-")), "8-2147483647");
  });
});
