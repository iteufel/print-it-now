import { InvalidOptionError } from "./errors.js";

/**
 * A 1-based, inclusive page range. `to === OPEN_ENDED` means "through the last
 * page", which is only resolvable once the document is open.
 */
export interface PageRange {
  from: number;
  to: number;
}

/** Sentinel for the `to` end of an open-ended range such as `"8-"`. */
export const OPEN_ENDED = 0;

/**
 * Parses a page range expression into ranges the native layer can resolve.
 *
 * Accepts the syntax printing tools have long shared: comma-separated single
 * pages and `from-to` ranges, with either end omissible (`"-4"` is pages 1 to 4,
 * `"8-"` is page 8 to the end). Whitespace is ignored.
 *
 * Ranges are deliberately left unsorted and unmerged; overlap is resolved
 * natively against the real page count, where it can also be clamped.
 */
export function parsePageRanges(expression: string): PageRange[] {
  if (typeof expression !== "string") {
    throw new InvalidOptionError("pages", "expected a range expression such as \"1-3,5,8-\"");
  }
  // Whitespace is stripped wholesale rather than only around commas, so that
  // "1 - 3, 5" parses the same as "1-3,5".
  const compact = expression.replace(/\s+/g, "");
  if (compact === "") {
    throw new InvalidOptionError("pages", "the range expression is empty");
  }

  const ranges: PageRange[] = [];
  for (const part of compact.split(",")) {
    if (part === "") {
      throw new InvalidOptionError(
        "pages",
        `"${expression}" has an empty entry; ranges are comma-separated, as in "1-3,5,8-"`,
      );
    }

    const match = /^(\d*)(?:(-)(\d*))?$/.exec(part);
    if (!match) {
      throw new InvalidOptionError(
        "pages",
        `"${part}" is not a page or page range; expected forms are "5", "1-3", "-4" or "8-"`,
      );
    }

    const [, rawFrom, dash, rawTo] = match;

    if (!dash) {
      // A bare page number.
      if (rawFrom === "") {
        throw new InvalidOptionError("pages", `"${part}" is not a page number`);
      }
      const page = Number(rawFrom);
      if (page < 1) {
        throw new InvalidOptionError("pages", "page numbers start at 1");
      }
      ranges.push({ from: page, to: page });
      continue;
    }

    if (rawFrom === "" && rawTo === "") {
      throw new InvalidOptionError(
        "pages",
        `"${part}" has no bounds; use "1-" for "everything from page 1"`,
      );
    }

    const from = rawFrom === "" ? 1 : Number(rawFrom);
    const to = rawTo === "" ? OPEN_ENDED : Number(rawTo);
    if (from < 1) {
      throw new InvalidOptionError("pages", "page numbers start at 1");
    }
    if (to !== OPEN_ENDED && to < from) {
      throw new InvalidOptionError(
        "pages",
        `"${part}" ends before it starts; write it as "${to}-${from}" if that was the intent`,
      );
    }
    ranges.push({ from, to });
  }

  return ranges;
}

/**
 * Formats ranges as the IPP `page-ranges` attribute value.
 *
 * IPP has no open-ended form, so `"8-"` needs a concrete upper bound. `2147483647`
 * is what CUPS itself uses for this and every implementation clamps it to the
 * document length.
 */
export function toIppPageRanges(ranges: PageRange[]): string {
  const IPP_LAST_PAGE = 2147483647;
  return ranges
    .map(({ from, to }) => `${from}-${to === OPEN_ENDED ? IPP_LAST_PAGE : to}`)
    .join(",");
}
