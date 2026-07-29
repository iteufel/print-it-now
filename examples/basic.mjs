/**
 * The shortest useful thing you can do with print-it-now.
 *
 * Run with:  node examples/basic.mjs [printer-name]
 */

import { getBackendInfo, getDefaultPrinter, listPrinters, printPdf } from "print-it-now";
import { readFile } from "node:fs/promises";

const requestedPrinter = process.argv[2];

console.log("Backend:", await getBackendInfo());

const printers = await listPrinters();
if (printers.length === 0) {
  console.error("No printers are configured on this machine.");
  process.exit(1);
}

console.log("\nAvailable printers:");
for (const printer of printers) {
  console.log(`  ${printer.name}${printer.isDefault ? " (default)" : ""} - ${printer.state}`);
}

const target = requestedPrinter ?? (await getDefaultPrinter())?.name;
console.log(`\nPrinting to: ${target}`);

// A path lets the backend stream the file, so a large PDF never has to sit in
// the JS heap. Pass a Buffer instead when the PDF was generated in memory.
const job = await printPdf("./document.pdf", {
  printer: target,
  jobName: "Quarterly report",
  copies: 1,
  duplex: "long-edge",
  paperSize: "A4",
  // "shrink" is the default: pages larger than the paper are scaled down, pages
  // that already fit are left at 100%.
  scale: "shrink",
});

console.log("Submitted:", job);

// Printing a PDF held in memory works the same way, and never touches disk.
const bytes = await readFile("./document.pdf");
const second = await printPdf(bytes, { printer: target, jobName: "From memory", pages: "1-2" });
console.log("Submitted:", second);
