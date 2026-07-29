import { spawn } from "node:child_process";
import {
  BackendError,
  BackendUnavailableError,
  JobNotFoundError,
  PrinterNotFoundError,
} from "../errors.js";
import type { Printer } from "../types.js";
import type { NativeRequest } from "../options.js";

/**
 * A CUPS backend of last resort, driving the `lp` command line tools.
 *
 * This exists so that a machine with the CUPS *tools* but not the CUPS *shared
 * library* -- a slim container that installed `cups-client` but not `libcups2`,
 * say -- can still print, rather than the package failing outright. It is not
 * the preferred path: spawning a process per job is slower, and the tools report
 * far less than the library does.
 *
 * Every child process runs with `LC_ALL=C` so that the strings parsed out of its
 * output are the untranslated ones. Without that, a German or Japanese system
 * would produce output this code cannot read.
 */

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(command: string, args: string[], input?: Uint8Array): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new BackendUnavailableError(
            `The "${command}" command was not found, so the CUPS command line fallback is ` +
              "unavailable. Install the CUPS client tools (Debian/Ubuntu: cups-client; " +
              "Fedora: cups-client; Alpine: cups-client).",
            { cause: error },
          ),
        );
        return;
      }
      reject(new BackendError(`Could not run "${command}": ${error.message}`, { cause: error }));
    });

    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));

    if (input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // `lp` closing stdin early (a rejected job) would otherwise surface as an
        // unhandled EPIPE rather than the exit status that actually explains it.
      });
      child.stdin.end(input);
    }
  });
}

/** Whether the fallback can be used at all. */
export async function isAvailable(): Promise<boolean> {
  try {
    const result = await run("lp", ["--version"]);
    // `lp` has no --version and exits non-zero, but reaching this point at all
    // means the binary exists, which is the only thing being tested.
    return result.code !== -1;
  } catch {
    return false;
  }
}

export async function listPrinters(): Promise<Printer[]> {
  // `lpstat -e` prints one destination name per line and nothing else, which is
  // the only lpstat output that is not prose.
  const result = await run("lpstat", ["-e"]);
  if (result.code !== 0 && result.stdout.trim() === "") {
    // No destinations is a normal outcome and lpstat signals it with a non-zero
    // exit, so it must not be treated as a failure.
    if (/no destinations|No destinations/.test(result.stderr)) return [];
    throw new BackendError(`lpstat failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }

  const names = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const defaultPrinter = await getDefaultPrinter();

  return names.map((name) => ({
    name,
    isDefault: name === defaultPrinter,
    // The command line tools only report state as localised prose, so it is left
    // unknown rather than guessed at.
    state: "unknown" as const,
  }));
}

export async function getDefaultPrinter(): Promise<string | null> {
  const result = await run("lpstat", ["-d"]);
  const output = result.stdout.trim();
  if (output === "" || /no system default destination/i.test(output)) return null;
  const separator = output.lastIndexOf(":");
  if (separator === -1) return null;
  const name = output.slice(separator + 1).trim();
  return name === "" ? null : name;
}

export async function print(
  request: NativeRequest,
): Promise<{ jobId: number; printer: string; jobName: string }> {
  const args = ["-d", request.printer];
  if (request.jobName !== "") args.push("-t", request.jobName);
  for (const [key, value] of request.ipp) args.push("-o", `${key}=${value}`);
  if (request.filePath !== undefined) args.push("--", request.filePath);

  const result = await run("lp", args, request.filePath === undefined ? request.data : undefined);
  if (result.code !== 0) {
    const message = result.stderr.trim() || `lp exited with code ${result.code}`;
    if (/unknown destination|does not exist/i.test(message)) {
      throw new PrinterNotFoundError(request.printer);
    }
    throw new BackendError(`lp refused the job: ${message}`);
  }

  // "request id is PDF-7 (1 file(s))" -- the trailing number of the id is the
  // job id that `cancel` and `lpstat` use.
  const match = /request id is (\S+)/.exec(result.stdout);
  const jobId = match ? Number(match[1]!.slice(match[1]!.lastIndexOf("-") + 1)) : Number.NaN;

  return {
    jobId: Number.isFinite(jobId) ? jobId : 0,
    printer: request.printer,
    jobName: request.jobName,
  };
}

/**
 * Whether a `cancel` failure message means the job is no longer pending.
 *
 * CUPS does not distinguish "already finished" from "never existed", and reports
 * an unknown queue the same way, because it resolves the job by number before it
 * ever looks at the printer. The library backend turns the equivalent IPP
 * statuses into JobNotFoundError; mapping the command line tool's prose onto the
 * same error keeps the code a caller sees from depending on which backend happens
 * to be active -- which is the entire point of having stable codes. Cancelling a
 * job that has just finished is a race every caller hits eventually, so the two
 * paths disagreeing about it is not a hypothetical.
 *
 * Exported for the unit tests: the prose is the contract with `cancel`, and the
 * CI failure that motivated this mapping would not have been caught by any other
 * check.
 */
export function isNotCancellableMessage(message: string): boolean {
  return /already (?:completed|canceled|cancelled|aborted)|does not exist|not found/i.test(
    message,
  );
}

export async function cancelJob(printer: string, jobId: number): Promise<void> {
  // `cancel` has no `--` end-of-options marker, but CUPS forbids queue names from
  // starting with `-`, so the job id can never be mistaken for a flag.
  const result = await run("cancel", [`${printer}-${jobId}`]);
  if (result.code === 0) return;

  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  if (isNotCancellableMessage(detail)) throw new JobNotFoundError(printer, jobId);

  throw new BackendError(`cancel failed for job ${jobId} on "${printer}": ${detail}`);
}
