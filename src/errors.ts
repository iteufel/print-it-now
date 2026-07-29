/** Stable, machine-readable discriminators for every error this package throws. */
export type PrintErrorCode =
  | "EINVALIDOPTION"
  | "EUNSUPPORTEDOPTION"
  | "ENOPRINTER"
  | "EPRINTERNOTFOUND"
  | "EINVALIDPDF"
  | "EBACKEND"
  | "EBACKENDUNAVAILABLE"
  | "EJOBNOTFOUND";

export class PrintError extends Error {
  readonly code: PrintErrorCode;
  /** Native error number from the backend (Win32 `GetLastError`, IPP status). */
  readonly nativeCode?: number;
  /** Verbatim backend message, when there was one. */
  readonly nativeMessage?: string;

  constructor(
    message: string,
    code: PrintErrorCode,
    details?: { nativeCode?: number; nativeMessage?: string; cause?: unknown },
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    if (details?.nativeCode !== undefined) this.nativeCode = details.nativeCode;
    if (details?.nativeMessage !== undefined) this.nativeMessage = details.nativeMessage;
  }
}

/** An option value was malformed: a negative copy count, an unparsable range, … */
export class InvalidOptionError extends PrintError {
  readonly option: string;

  constructor(option: string, message: string) {
    super(`Invalid value for option "${option}": ${message}`, "EINVALIDOPTION");
    this.option = option;
  }
}

/**
 * A well-formed option the current platform's backend cannot honour.
 *
 * Thrown rather than ignored so that a job never silently comes out different
 * from what was requested. Set `ignoreUnsupportedOptions: true` to downgrade
 * this to a no-op.
 */
export class UnsupportedOptionError extends PrintError {
  readonly option: string;
  readonly platform: string;

  constructor(option: string, platform: string, hint?: string) {
    super(
      `Option "${option}" is not supported by the ${platform} backend` + (hint ? `. ${hint}` : ""),
      "EUNSUPPORTEDOPTION",
    );
    this.option = option;
    this.platform = platform;
  }
}

/** No printer was named and the system has no default printer configured. */
export class NoPrinterError extends PrintError {
  constructor() {
    super(
      "No printer specified and no system default printer is configured. " +
        "Pass options.printer, or check listPrinters() for available queues.",
      "ENOPRINTER",
    );
  }
}

/** The named queue does not exist. */
export class PrinterNotFoundError extends PrintError {
  readonly printer: string;

  constructor(printer: string, available?: string[]) {
    super(
      `Printer "${printer}" was not found` +
        (available && available.length > 0
          ? `. Available printers: ${available.map((p) => `"${p}"`).join(", ")}`
          : ". No printers are currently available on this system."),
      "EPRINTERNOTFOUND",
    );
    this.printer = printer;
  }
}

/** The input was not a PDF, or was a PDF the renderer could not open. */
export class InvalidPdfError extends PrintError {
  constructor(message: string, details?: { nativeCode?: number; cause?: unknown }) {
    super(message, "EINVALIDPDF", details);
  }
}

/** The backend rejected or failed the job. */
export class BackendError extends PrintError {
  constructor(
    message: string,
    details?: { nativeCode?: number; nativeMessage?: string; cause?: unknown },
  ) {
    super(message, "EBACKEND", details);
  }
}

/**
 * The platform's printing subsystem could not be reached at all: no CUPS
 * library and no `lp` binary, or the Windows spooler service is not running.
 */
export class BackendUnavailableError extends PrintError {
  constructor(message: string, details?: { cause?: unknown }) {
    super(message, "EBACKENDUNAVAILABLE", details);
  }
}

/** {@link getJob} or {@link cancelJob} referenced a job the queue does not have. */
export class JobNotFoundError extends PrintError {
  readonly jobId: number;

  constructor(printer: string, jobId: number) {
    super(`Job ${jobId} was not found on printer "${printer}"`, "EJOBNOTFOUND");
    this.jobId = jobId;
  }
}

/**
 * Maps a structured error thrown by the native addon onto the public error
 * classes. The addon attaches a `code` property using the same discriminators.
 */
export function fromNativeError(err: unknown, context: { printer?: string }): PrintError {
  if (err instanceof PrintError) return err;

  const raw = err as
    | { message?: string; code?: string; nativeCode?: number; nativeMessage?: string }
    | undefined;
  const message = raw?.message ?? "Unknown native printing error";
  const nativeCode = raw?.nativeCode;
  const nativeMessage = raw?.nativeMessage;

  switch (raw?.code) {
    case "EPRINTERNOTFOUND":
      return new PrinterNotFoundError(context.printer ?? "<unknown>");
    case "ENOPRINTER":
      return new NoPrinterError();
    case "EINVALIDPDF":
      return new InvalidPdfError(message, { nativeCode, cause: err });
    case "EBACKENDUNAVAILABLE":
      return new BackendUnavailableError(message, { cause: err });
    case "EJOBNOTFOUND":
      return new JobNotFoundError(context.printer ?? "<unknown>", -1);
    default:
      return new BackendError(message, { nativeCode, nativeMessage, cause: err });
  }
}
