#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import {
  PrintError,
  cancelJob,
  getBackendInfo,
  getJob,
  listJobs,
  listPrinters,
  printPdf,
} from "./index.js";
import type { PrintOptions } from "./types.js";

const USAGE = `print-it-now - headless PDF printing

Usage:
  print-it-now <file.pdf> [options]     print a PDF (use - to read stdin)
  print-it-now printers                 list available printers
  print-it-now backend                  show which backend is in use
  print-it-now jobs <printer>           list jobs in a printer's queue
  print-it-now job <printer> <id>       show the state of a job
  print-it-now cancel <printer> <id>    cancel a job

Print options:
  -p, --printer <name>      destination queue (default: the system default)
  -t, --title <name>        job title shown in the queue
  -n, --copies <n>          number of copies
      --no-collate          do not collate multi-page copies
      --pages <ranges>      page selection, e.g. 1-3,5,8-
      --page-set <set>      all | odd | even
      --reverse             print last page first
      --duplex <mode>       simplex | long-edge | short-edge
      --orientation <o>     portrait | landscape
      --paper <size>        A4, Letter, ... or 210x297mm
      --tray <name|id>      input tray
      --color <mode>        color | monochrome | auto
      --quality <q>         draft | normal | high
      --scale <mode>        actual | fit | shrink | noscale-clip
      --dpi <n>             rasterisation resolution (Windows bitmap mode)
      --number-up <n>       pages per sheet (1, 2, 4, 6, 9, 16)
  -o, --option <k=v>        raw IPP attribute (repeatable, CUPS only)
      --render-mode <m>     vector | bitmap (Windows only)
      --print-mode <m>      PDFium print mode (Windows, vector mode only)
      --output-file <path>  spool to a file (Windows, needed by file-backed drivers)
      --json                machine-readable output
  -h, --help                show this help
`;

class UsageError extends Error {}

interface ParsedArgs {
  command: string;
  positional: string[];
  options: PrintOptions;
  json: boolean;
}

function parseCustomPaper(value: string): PrintOptions["paperSize"] {
  // "210x297mm" and "210x297" both mean millimetres; anything else is a name.
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm)?$/i.exec(value);
  if (!match) return value;
  return { widthMm: Number(match[1]), heightMm: Number(match[2]) };
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new UsageError(`${flag} needs a value`);
  return value;
}

function parseInteger(flag: string, value: string | undefined): number {
  const parsed = Number(requireValue(flag, value));
  if (!Number.isInteger(parsed)) throw new UsageError(`${flag} needs an integer, got "${value}"`);
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: PrintOptions = {};
  const ipp: Record<string, string> = {};
  const windows: NonNullable<PrintOptions["windows"]> = {};
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i];

    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--json":
        json = true;
        break;
      case "-p":
      case "--printer":
        options.printer = requireValue(arg, next());
        break;
      case "-t":
      case "--title":
        options.jobName = requireValue(arg, next());
        break;
      case "-n":
      case "--copies":
        options.copies = parseInteger(arg, next());
        break;
      case "--no-collate":
        options.collate = false;
        break;
      case "--pages":
        options.pages = requireValue(arg, next());
        break;
      case "--page-set":
        options.pageSubset = requireValue(arg, next()) as PrintOptions["pageSubset"];
        break;
      case "--reverse":
        options.reverse = true;
        break;
      case "--duplex":
        options.duplex = requireValue(arg, next()) as PrintOptions["duplex"];
        break;
      case "--orientation":
        options.orientation = requireValue(arg, next()) as PrintOptions["orientation"];
        break;
      case "--paper":
        options.paperSize = parseCustomPaper(requireValue(arg, next()));
        break;
      case "--tray":
        options.tray = requireValue(arg, next());
        break;
      case "--color":
        options.color = requireValue(arg, next()) as PrintOptions["color"];
        break;
      case "--quality":
        options.quality = requireValue(arg, next()) as PrintOptions["quality"];
        break;
      case "--scale":
        options.scale = requireValue(arg, next()) as PrintOptions["scale"];
        break;
      case "--dpi":
        options.dpi = parseInteger(arg, next());
        break;
      case "--number-up":
        options.numberUp = parseInteger(arg, next());
        break;
      case "-o":
      case "--option": {
        const pair = requireValue(arg, next());
        const separator = pair.indexOf("=");
        if (separator === -1) throw new UsageError(`${arg} expects key=value, got "${pair}"`);
        ipp[pair.slice(0, separator)] = pair.slice(separator + 1);
        break;
      }
      case "--render-mode":
        windows.renderMode = requireValue(arg, next()) as typeof windows.renderMode;
        break;
      case "--print-mode":
        windows.printMode = requireValue(arg, next()) as typeof windows.printMode;
        break;
      case "--output-file":
        windows.outputFile = requireValue(arg, next());
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") throw new UsageError(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (Object.keys(ipp).length > 0) options.ipp = ipp;
  if (Object.keys(windows).length > 0) options.windows = windows;

  const [first = "", ...rest] = positional;
  const commands = new Set(["printers", "backend", "jobs", "job", "cancel"]);
  return commands.has(first)
    ? { command: first, positional: rest, options, json }
    : { command: "print", positional, options, json };
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function emit(json: boolean, value: unknown, text: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text());
}

async function main(): Promise<number> {
  const { command, positional, options, json } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "printers": {
      const printers = await listPrinters();
      emit(json, printers, () => {
        if (printers.length === 0) return "No printers are available on this system.\n";
        return (
          printers
            .map((printer) => {
              const marks = [printer.state, printer.isDefault ? "default" : undefined]
                .filter(Boolean)
                .join(", ");
              return `${printer.name}  [${marks}]${printer.driver ? `  ${printer.driver}` : ""}`;
            })
            .join("\n") + "\n"
        );
      });
      return 0;
    }

    case "backend": {
      const info = await getBackendInfo();
      emit(json, info, () => {
        const details = [
          info.pdfiumVersion ? `PDFium ${info.pdfiumVersion}` : undefined,
          info.cupsLibrary ? `via ${info.cupsLibrary}` : undefined,
        ].filter(Boolean);
        return `${info.backend}${details.length > 0 ? ` (${details.join(", ")})` : ""}\n`;
      });
      return 0;
    }

    case "jobs": {
      const [printer] = positional;
      if (printer === undefined) throw new UsageError("jobs needs a printer name");
      const jobs = await listJobs(printer);
      emit(json, jobs, () => {
        if (jobs.length === 0) return `No jobs in the queue on "${printer}".\n`;
        return (
          jobs.map((job) => `${job.jobId}  ${job.jobName}: ${job.state}`).join("\n") + "\n"
        );
      });
      return 0;
    }

    case "job": {
      const [printer, id] = positional;
      if (printer === undefined || id === undefined) {
        throw new UsageError("job needs a printer name and a job id");
      }
      const status = await getJob(printer, Number(id));
      if (status === null) {
        emit(json, null, () => `Job ${id} is no longer in the queue on "${printer}".\n`);
        return 0;
      }
      emit(json, status, () => `${status.jobName}: ${status.state}\n`);
      return 0;
    }

    case "cancel": {
      const [printer, id] = positional;
      if (printer === undefined || id === undefined) {
        throw new UsageError("cancel needs a printer name and a job id");
      }
      await cancelJob(printer, Number(id));
      emit(json, { canceled: true }, () => `Cancelled job ${id} on "${printer}".\n`);
      return 0;
    }

    default: {
      const [path] = positional;
      if (path === undefined) {
        process.stderr.write(USAGE);
        return 2;
      }
      const source = path === "-" ? await readStdin() : await readFile(path);
      const job = await printPdf(source, {
        jobName: path === "-" ? "stdin" : path,
        ...options,
      });
      emit(
        json,
        job,
        () =>
          `Submitted "${job.jobName}" to "${job.printer}" as job ${job.jobId}` +
          `${job.pageCount !== undefined ? ` (${job.pageCount} pages)` : ""}.\n`,
      );
      return 0;
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof PrintError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
