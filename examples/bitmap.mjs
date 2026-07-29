/**
 * Print a synthetic raw bitmap without wrapping it in a PDF.
 *
 * Run with:  node examples/bitmap.mjs [printer-name]
 */

import { getBackendInfo, getDefaultPrinter, listPrinters, printBitmap } from "print-it-now";

const requestedPrinter = process.argv[2];

console.log("Backend:", await getBackendInfo());

const printers = await listPrinters();
if (printers.length === 0) {
  console.error("No printers are configured on this machine.");
  process.exit(1);
}

const target = requestedPrinter ?? (await getDefaultPrinter())?.name;
console.log(`Printing bitmap to: ${target}`);

const width = 320;
const height = 200;
const data = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = Math.floor((x / width) * 255); // R
    data[i + 1] = Math.floor((y / height) * 255); // G
    data[i + 2] = 64; // B
    data[i + 3] = 255; // A
  }
}

const job = await printBitmap(
  { width, height, data, format: "rgba" },
  {
    printer: target,
    jobName: "Gradient bitmap",
    paperSize: "A4",
    scale: "fit",
    dpi: 72,
  },
);

console.log("Submitted:", job);
