/**
 * Paper size and tray name tables.
 *
 * Windows wants a numeric `DMPAPER_*` constant in the DEVMODE; CUPS wants a
 * media name. The two vocabularies do not overlap, so every size the package
 * accepts by name is listed once here with both spellings, and sizes Windows has
 * no constant for (A0, A1, and anything custom) fall back to explicit
 * dimensions.
 */

/** DEVMODE dmPaperSize value for a caller-specified size. */
export const DMPAPER_USER = 256;

export interface PaperSizeEntry {
  /** Canonical name, as reported back in error messages. */
  name: string;
  /** `DMPAPER_*`; omitted for sizes Windows has no constant for. */
  dm?: number;
  /** Self-describing PWG media name, understood by both PPD and IPP queues. */
  pwg: string;
  widthMm: number;
  heightMm: number;
  /** Extra spellings accepted for this size, already normalised. */
  aliases?: string[];
}

const PAPER_SIZES: PaperSizeEntry[] = [
  { name: "A0", pwg: "iso_a0_841x1189mm", widthMm: 841, heightMm: 1189 },
  { name: "A1", pwg: "iso_a1_594x841mm", widthMm: 594, heightMm: 841 },
  { name: "A2", dm: 66, pwg: "iso_a2_420x594mm", widthMm: 420, heightMm: 594 },
  { name: "A3", dm: 8, pwg: "iso_a3_297x420mm", widthMm: 297, heightMm: 420 },
  { name: "A4", dm: 9, pwg: "iso_a4_210x297mm", widthMm: 210, heightMm: 297 },
  { name: "A5", dm: 11, pwg: "iso_a5_148x210mm", widthMm: 148, heightMm: 210 },
  { name: "A6", dm: 70, pwg: "iso_a6_105x148mm", widthMm: 105, heightMm: 148 },
  { name: "B4", dm: 12, pwg: "jis_b4_257x364mm", widthMm: 257, heightMm: 364, aliases: ["jisb4"] },
  { name: "B5", dm: 13, pwg: "jis_b5_182x257mm", widthMm: 182, heightMm: 257, aliases: ["jisb5"] },
  {
    name: "Letter",
    dm: 1,
    pwg: "na_letter_8.5x11in",
    widthMm: 215.9,
    heightMm: 279.4,
    aliases: ["usletter", "ansia"],
  },
  { name: "Legal", dm: 5, pwg: "na_legal_8.5x14in", widthMm: 215.9, heightMm: 355.6 },
  {
    name: "Tabloid",
    dm: 3,
    pwg: "na_ledger_11x17in",
    widthMm: 279.4,
    heightMm: 431.8,
    aliases: ["11x17", "ansib"],
  },
  { name: "Ledger", dm: 4, pwg: "na_ledger_11x17in", widthMm: 431.8, heightMm: 279.4 },
  {
    name: "Executive",
    dm: 7,
    pwg: "na_executive_7.25x10.5in",
    widthMm: 184.15,
    heightMm: 266.7,
  },
  {
    name: "Statement",
    dm: 6,
    pwg: "na_invoice_5.5x8.5in",
    widthMm: 139.7,
    heightMm: 215.9,
    aliases: ["halfletter", "invoice"],
  },
  { name: "Folio", dm: 14, pwg: "na_foolscap_8.5x13in", widthMm: 215.9, heightMm: 330.2 },
  { name: "Quarto", dm: 15, pwg: "om_quarto_215x275mm", widthMm: 215, heightMm: 275 },
  {
    name: "Env10",
    dm: 20,
    pwg: "na_number-10_4.125x9.5in",
    widthMm: 104.775,
    heightMm: 241.3,
    aliases: ["comm10", "envelope10", "no10"],
  },
  { name: "EnvDL", dm: 27, pwg: "iso_dl_110x220mm", widthMm: 110, heightMm: 220, aliases: ["dl"] },
  { name: "EnvC4", dm: 30, pwg: "iso_c4_229x324mm", widthMm: 229, heightMm: 324, aliases: ["c4"] },
  { name: "EnvC5", dm: 28, pwg: "iso_c5_162x229mm", widthMm: 162, heightMm: 229, aliases: ["c5"] },
  { name: "EnvC6", dm: 31, pwg: "iso_c6_114x162mm", widthMm: 114, heightMm: 162, aliases: ["c6"] },
  {
    name: "EnvMonarch",
    dm: 37,
    pwg: "na_monarch_3.875x7.5in",
    widthMm: 98.425,
    heightMm: 190.5,
    aliases: ["monarch"],
  },
  {
    name: "Photo4x6",
    pwg: "na_index-4x6_4x6in",
    widthMm: 101.6,
    heightMm: 152.4,
    aliases: ["4x6", "index4x6"],
  },
];

/** DEVMODE `DMBIN_*` values, keyed by the names this package accepts. */
const PAPER_BINS: Record<string, number> = {
  upper: 1,
  onlyone: 1,
  lower: 2,
  middle: 3,
  manual: 4,
  envelope: 5,
  envmanual: 6,
  auto: 7,
  tractor: 8,
  smallformat: 9,
  largeformat: 10,
  largecapacity: 11,
  cassette: 14,
  formsource: 15,
};

/** Folds spelling variants together: "US Letter", "us-letter" and "usletter" all match. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

const BY_NAME = new Map<string, PaperSizeEntry>();
for (const entry of PAPER_SIZES) {
  BY_NAME.set(normalizeName(entry.name), entry);
  for (const alias of entry.aliases ?? []) BY_NAME.set(normalizeName(alias), entry);
}

export function findPaperSize(name: string): PaperSizeEntry | undefined {
  return BY_NAME.get(normalizeName(name));
}

export function knownPaperSizeNames(): string[] {
  return PAPER_SIZES.map((entry) => entry.name);
}

export function findPaperBin(name: string): number | undefined {
  return PAPER_BINS[normalizeName(name)];
}

export function knownPaperBinNames(): string[] {
  return Object.keys(PAPER_BINS);
}

/**
 * CUPS media name for an explicit size. `Custom.WIDTHxHEIGHTmm` is the legacy
 * spelling, which CUPS normalises into a PWG custom name; it is understood by
 * both PPD-based and driverless queues, whereas the PWG `custom_…` form is not
 * accepted by older PPD queues.
 */
export function customMediaName(widthMm: number, heightMm: number): string {
  const round = (value: number) => Number(value.toFixed(2));
  return `Custom.${round(widthMm)}x${round(heightMm)}mm`;
}

/** DEVMODE carries paper dimensions in tenths of a millimetre. */
export function toTenthsOfMm(millimetres: number): number {
  return Math.round(millimetres * 10);
}
