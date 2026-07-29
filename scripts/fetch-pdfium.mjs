#!/usr/bin/env node
/**
 * Downloads the pinned PDFium runtime for a Windows target and stages it next to
 * the compiled addon.
 *
 * PDFium is only needed on Windows -- CUPS consumes PDF natively -- so this is a
 * no-op on other platforms unless a target is named explicitly. The download is
 * checked against the sha256 recorded in native/third_party/pdfium/pdfium.lock.json;
 * a mismatch aborts rather than warns, because a silently wrong renderer is much
 * harder to diagnose than a failed build.
 *
 * Usage:
 *   node scripts/fetch-pdfium.mjs                     # current platform/arch
 *   node scripts/fetch-pdfium.mjs --target win32-arm64
 *   node scripts/fetch-pdfium.mjs --target win32-x64 --out prebuilds/win32-x64
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, copyFile, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const pdfiumDir = join(repoRoot, "native", "third_party", "pdfium");
const lockPath = join(pdfiumDir, "pdfium.lock.json");
const cacheDir = join(pdfiumDir, ".cache");

function parseArgs(argv) {
  const args = { target: undefined, out: undefined, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") args.target = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status} ${response.statusText}`);
  }
  if (!response.body) throw new Error(`GET ${url} returned an empty body`);
  await mkdir(dirname(destination), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  return bytes.length;
}

/**
 * Extracts a .tgz using the platform `tar`. Node has no built-in tar reader, and
 * `tar` is present on every runner we build on (Windows has shipped bsdtar since
 * Windows 10 1803).
 */
async function extract(archive, into) {
  await mkdir(into, { recursive: true });
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("tar", ["-xzf", archive, "-C", into], { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`tar exited with code ${code}`));
    });
  });
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination);
    else await copyFile(source, destination);
  }
}

function currentTarget() {
  const arch = process.arch === "ia32" ? "ia32" : process.arch;
  return `${process.platform}-${arch}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/fetch-pdfium.mjs [--target <platform-arch>] [--out <dir>] [--force]\n",
    );
    return;
  }

  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const target = args.target ?? currentTarget();

  if (!target.startsWith("win32-")) {
    process.stdout.write(
      `PDFium is only required on Windows; nothing to do for ${target}. ` +
        "The CUPS backend prints PDF directly.\n",
    );
    return;
  }

  const archive = lock.archives[target];
  if (!archive) {
    const known = Object.keys(lock.archives).join(", ");
    throw new Error(`No pinned PDFium archive for target "${target}". Known targets: ${known}`);
  }

  const outDir = resolve(repoRoot, args.out ?? join("prebuilds", target));
  const dllPath = join(outDir, "pdfium.dll");
  if (!args.force && (await exists(dllPath))) {
    process.stdout.write(`pdfium.dll already staged at ${dllPath}; pass --force to refetch.\n`);
    return;
  }

  // The tag contains a slash ("chromium/7961"), which has to stay encoded in the
  // download path or GitHub reads it as an extra path segment.
  const encodedTag = lock.tag.replace(/\//g, "%2F");
  const url =
    `https://github.com/${lock.repository}/releases/download/${encodedTag}/${archive.asset}`;

  const archivePath = join(cacheDir, `${lock.tag.replace(/\//g, "-")}-${archive.asset}`);
  if (args.force || !(await exists(archivePath))) {
    process.stdout.write(`Downloading ${url}\n`);
    const size = await download(url, archivePath);
    process.stdout.write(`Downloaded ${size} bytes\n`);
  } else {
    process.stdout.write(`Using cached ${archivePath}\n`);
  }

  const digest = await sha256(archivePath);
  if (digest !== archive.sha256) {
    await rm(archivePath, { force: true });
    throw new Error(
      `Checksum mismatch for ${archive.asset}\n` +
        `  expected ${archive.sha256}\n` +
        `  actual   ${digest}\n` +
        "The cached download has been deleted. If PDFium was intentionally " +
        "upgraded, update native/third_party/pdfium/pdfium.lock.json and " +
        "re-vendor include/fpdfview.h from the same release.",
    );
  }
  process.stdout.write(`Checksum verified (sha256 ${digest})\n`);

  const stagingDir = join(cacheDir, `extract-${target}`);
  await rm(stagingDir, { recursive: true, force: true });
  await extract(archivePath, stagingDir);

  const extractedDll = join(stagingDir, "bin", "pdfium.dll");
  if (!(await exists(extractedDll))) {
    throw new Error(`${archive.asset} did not contain bin/pdfium.dll`);
  }

  await mkdir(outDir, { recursive: true });
  await copyFile(extractedDll, dllPath);
  // Redistributing the DLL means redistributing its licences alongside it.
  await copyFile(join(stagingDir, "LICENSE"), join(outDir, "PDFIUM-LICENSE.txt"));
  if (await exists(join(stagingDir, "licenses"))) {
    await copyTree(join(stagingDir, "licenses"), join(outDir, "pdfium-licenses"));
  }
  await writeFile(
    join(outDir, "pdfium-version.txt"),
    `${lock.version} (${lock.repository} ${lock.tag})\n`,
  );

  await rm(stagingDir, { recursive: true, force: true });
  process.stdout.write(`Staged PDFium ${lock.version} at ${dllPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
