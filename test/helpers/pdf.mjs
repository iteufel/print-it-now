/**
 * A minimal PDF writer, just enough to produce real multi-page documents for
 * the test suite. Using a generator rather than checked-in binary fixtures keeps
 * page counts and page sizes as test parameters, which is what the interesting
 * cases (page ranges, scaling, landscape media) actually vary.
 */

import { inflateSync } from "node:zlib";

const LETTER = { width: 612, height: 792 };

function escapeText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * @param {object} [options]
 * @param {number} [options.pages] Number of pages. Defaults to 1.
 * @param {number} [options.width] Page width in PostScript points. Defaults to US Letter.
 * @param {number} [options.height] Page height in points.
 * @param {string} [options.label] Text stamped on each page, suffixed with the page number.
 * @returns {Buffer}
 */
export function makePdf(options = {}) {
  const pageCount = options.pages ?? 1;
  const width = options.width ?? LETTER.width;
  const height = options.height ?? LETTER.height;
  const label = options.label ?? "print-it-now test page";

  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new TypeError(`pages must be a positive integer, got ${options.pages}`);
  }

  // Object 1 is the catalog, 2 the page tree, 3 the font. Each page then takes
  // two objects: the page dictionary and its content stream.
  const objects = [];
  const pageIds = [];
  for (let i = 0; i < pageCount; i += 1) {
    pageIds.push(4 + i * 2);
  }

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${pageCount} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  for (let i = 0; i < pageCount; i += 1) {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const text =
      `BT /F1 24 Tf 72 ${height - 100} Td ` +
      `(${escapeText(label)} ${i + 1} of ${pageCount}) Tj ET\n` +
      // A border makes it obvious in a rendered result whether scaling clipped
      // the page.
      `1 w 36 36 ${width - 72} ${height - 72} re S\n`;

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}endstream`;
  }

  const chunks = [];
  const offsets = [];
  let position = 0;

  const push = (text) => {
    const buffer = Buffer.from(text, "latin1");
    chunks.push(buffer);
    position += buffer.length;
  };

  push("%PDF-1.4\n");
  // A binary comment marks the file as containing 8-bit data, which is what
  // makes tools treat it as binary rather than mangling line endings.
  chunks.push(Buffer.from([0x25, 0xc2, 0xb5, 0xc2, 0xb6, 0x0a]));
  position += 6;

  const highestId = objects.length - 1;
  for (let id = 1; id <= highestId; id += 1) {
    offsets[id] = position;
    push(`${id} 0 obj\n${objects[id]}\nendobj\n`);
  }

  const xrefOffset = position;
  let xref = `xref\n0 ${highestId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= highestId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${highestId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * Counts the pages in a PDF produced by a printer driver.
 *
 * The page tree normally sits in plain text, but PDF 1.5 lets a writer pack
 * object dictionaries into compressed object streams -- which Windows' "Microsoft
 * Print to PDF" driver does -- and then nothing is visible without inflating
 * them. Both cases are handled so the end-to-end assertions mean the same thing
 * on every platform.
 */
export function countPdfPages(buffer) {
  const direct = countInText(buffer.toString("latin1"));
  if (direct > 0) return direct;

  for (const inflated of inflateObjectStreams(buffer)) {
    const count = countInText(inflated);
    if (count > 0) return count;
  }
  return 0;
}

function countInText(text) {
  // The root page tree's /Count is authoritative. Anchoring on /Type /Pages
  // avoids matching the /Count of an outline or an unrelated dictionary.
  const pagesDict = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/s.exec(text);
  if (pagesDict) return Number(pagesDict[1]);
  const countBeforeType = /\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/s.exec(text);
  if (countBeforeType) return Number(countBeforeType[1]);
  // Fall back to counting leaves. The negative lookahead keeps /Type /Pages from
  // being counted as a page.
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

function inflateObjectStreams(buffer) {
  const results = [];
  const text = buffer.toString("latin1");
  const streamPattern = /stream\r?\n/g;

  let match;
  while ((match = streamPattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endstream", start);
    if (end === -1) continue;
    try {
      results.push(inflateSync(buffer.subarray(start, end)).toString("latin1"));
    } catch {
      // Not a Flate stream, or an image: nothing to read here.
    }
  }
  return results;
}
