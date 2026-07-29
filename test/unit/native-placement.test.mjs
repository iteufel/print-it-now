import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadNative } from "../../dist/internal.js";

/**
 * Mapping a PDF page onto a sheet is the fiddliest part of the Windows path:
 * a printer device context's origin sits at the top-left of the *printable* area
 * rather than the sheet, so centring has to account for that offset, and the four
 * scaling modes each anchor differently. It is pure arithmetic, so the addon
 * exports it for testing without a printer.
 */
const native = loadNative();

const SCALE = { actual: 0, fit: 1, shrink: 2, "noscale-clip": 3 };

/**
 * US Letter at 300 dpi with a 1/6" unprintable margin all round:
 * 8.5 x 11in -> 2550 x 3300 device pixels, printable 2450 x 3200 from (50, 50).
 */
const LETTER_SHEET = {
  dpiX: 300,
  dpiY: 300,
  physicalWidth: 2550,
  physicalHeight: 3300,
  printableWidth: 2450,
  printableHeight: 3200,
  offsetX: 50,
  offsetY: 50,
};

/** A4 at 300 dpi, 210 x 297mm, with the same margin. */
const A4_SHEET = {
  dpiX: 300,
  dpiY: 300,
  physicalWidth: 2480,
  physicalHeight: 3508,
  printableWidth: 2380,
  printableHeight: 3408,
  offsetX: 50,
  offsetY: 50,
};

const LETTER_PAGE = { width: 612, height: 792 };
const LANDSCAPE_LETTER_PAGE = { width: 792, height: 612 };

function place(page, sheet, scale, autoRotate = true) {
  return native._computePlacement(page.width, page.height, sheet, SCALE[scale], autoRotate);
}

describe("placement: actual size", () => {
  it("renders at exactly 100% of the page's own size", () => {
    // 612pt / 72 * 300dpi = 2550px, 792pt -> 3300px.
    const placement = place(LETTER_PAGE, LETTER_SHEET, "actual");
    assert.equal(placement.width, 2550);
    assert.equal(placement.height, 3300);
  });

  it("centres on the physical sheet, compensating for the printable origin", () => {
    // The page is exactly sheet-sized, so its corner is the sheet's corner --
    // which is 50px outside the printable area the device context starts at.
    const placement = place(LETTER_PAGE, LETTER_SHEET, "actual");
    assert.equal(placement.x, -50);
    assert.equal(placement.y, -50);
  });

  it("centres a smaller page on the sheet", () => {
    // A5 (420 x 595pt) at 300dpi is 1750 x 2479px on a 2550 x 3300 sheet.
    const placement = place({ width: 420, height: 595 }, LETTER_SHEET, "actual", false);
    assert.equal(placement.width, 1750);
    assert.equal(placement.x, Math.trunc((2550 - 1750) / 2) - 50);
  });
});

describe("placement: fit", () => {
  it("scales a page down to the printable area and centres it there", () => {
    const placement = place(LETTER_PAGE, LETTER_SHEET, "fit");
    assert.equal(placement.width, 2450, "limited by the printable width");
    // 3300 * (2450/2550) = 3170.6 -> 3171.
    assert.equal(placement.height, 3171);
    assert.equal(placement.x, 0);
    assert.equal(placement.y, Math.trunc((3200 - 3171) / 2));
  });

  it("scales a small page up, which is what distinguishes fit from shrink", () => {
    const placement = place({ width: 306, height: 396 }, LETTER_SHEET, "fit");
    assert.ok(placement.width > 1275, `expected enlargement, got ${placement.width}`);
    assert.equal(placement.width, 2450);
  });

  it("never exceeds the printable area in either direction", () => {
    for (const page of [
      { width: 100, height: 2000 },
      { width: 2000, height: 100 },
      { width: 2384, height: 3370 },
    ]) {
      const placement = place(page, A4_SHEET, "fit");
      assert.ok(
        placement.width <= A4_SHEET.printableWidth &&
          placement.height <= A4_SHEET.printableHeight,
        `${JSON.stringify(page)} produced ${placement.width}x${placement.height}`,
      );
    }
  });
});

describe("placement: shrink", () => {
  it("shrinks a page that would overflow", () => {
    // A4 content on a Letter sheet is taller than the paper, so it must come down.
    const placement = place({ width: 595, height: 842 }, LETTER_SHEET, "shrink");
    assert.ok(placement.height <= LETTER_SHEET.printableHeight);
    assert.ok(placement.width < 2479, `expected shrinking, got ${placement.width}`);
  });

  it("leaves a page that already fits at 100%", () => {
    // 306 x 396pt is 1275 x 1650px, comfortably inside the printable area.
    const placement = place({ width: 306, height: 396 }, LETTER_SHEET, "shrink", false);
    assert.equal(placement.width, 1275);
    assert.equal(placement.height, 1650);
  });
});

describe("placement: noscale-clip", () => {
  it("anchors at the printable origin instead of centring", () => {
    // Predictable for labels and pre-printed stationery, where centring would
    // move the content relative to what is already on the paper.
    const placement = place(LETTER_PAGE, LETTER_SHEET, "noscale-clip");
    assert.equal(placement.x, 0);
    assert.equal(placement.y, 0);
    assert.equal(placement.width, 2550);
    assert.equal(placement.height, 3300);
  });
});

describe("placement: auto-rotation", () => {
  it("turns a landscape page a quarter turn onto a portrait sheet", () => {
    const placement = place(LANDSCAPE_LETTER_PAGE, LETTER_SHEET, "shrink");
    assert.equal(placement.rotate, 1);
  });

  it("fills the sheet once rotated, rather than shrinking to fit across it", () => {
    const rotated = place(LANDSCAPE_LETTER_PAGE, LETTER_SHEET, "shrink");
    const unrotated = place(LANDSCAPE_LETTER_PAGE, LETTER_SHEET, "shrink", false);
    assert.ok(
      rotated.width * rotated.height > unrotated.width * unrotated.height,
      "rotating should use more of the sheet, not less",
    );
  });

  it("leaves a portrait page on a portrait sheet alone", () => {
    assert.equal(place(LETTER_PAGE, LETTER_SHEET, "shrink").rotate, 0);
  });

  it("leaves a landscape page on a landscape sheet alone", () => {
    const landscapeSheet = {
      ...LETTER_SHEET,
      physicalWidth: 3300,
      physicalHeight: 2550,
      printableWidth: 3200,
      printableHeight: 2450,
    };
    assert.equal(place(LANDSCAPE_LETTER_PAGE, landscapeSheet, "shrink").rotate, 0);
  });

  it("turns a portrait page onto a landscape sheet", () => {
    const landscapeSheet = {
      ...LETTER_SHEET,
      physicalWidth: 3300,
      physicalHeight: 2550,
      printableWidth: 3200,
      printableHeight: 2450,
    };
    assert.equal(place(LETTER_PAGE, landscapeSheet, "shrink").rotate, 1);
  });
});

describe("placement: degenerate input", () => {
  it("returns an empty placement for a zero-sized page rather than dividing by zero", () => {
    for (const page of [
      { width: 0, height: 792 },
      { width: 612, height: 0 },
      { width: -1, height: -1 },
    ]) {
      const placement = place(page, LETTER_SHEET, "fit");
      assert.equal(placement.width, 0, JSON.stringify(page));
      assert.equal(placement.height, 0);
    }
  });

  it("never produces a zero-sized destination for a real page", () => {
    // A rectangle of zero width or height would make StretchDIBits fail, so a
    // page scaled to almost nothing still has to occupy at least one pixel.
    const placement = place({ width: 1, height: 1 }, LETTER_SHEET, "shrink");
    assert.ok(placement.width >= 1 && placement.height >= 1);
  });

  it("copes with a driver that reports no physical extent", () => {
    // File-backed drivers sometimes report only the printable area.
    const placement = place(LETTER_PAGE, { ...LETTER_SHEET, physicalWidth: 0, physicalHeight: 0 }, "fit");
    assert.ok(placement.width > 0 && placement.height > 0);
  });

  it("honours a non-square resolution", () => {
    // 300 x 600 dpi devices exist; the two axes must scale independently.
    const placement = place(LETTER_PAGE, { ...LETTER_SHEET, dpiY: 600 }, "actual");
    assert.equal(placement.width, 2550);
    assert.equal(placement.height, 6600);
  });
});
