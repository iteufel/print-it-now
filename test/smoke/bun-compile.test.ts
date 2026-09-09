import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const root = join(dirname(import.meta.path), "../..");

const entryByPlatform: Record<string, string> = {
  darwin: "test/smoke/compile-apps/macos.ts",
  linux: "test/smoke/compile-apps/linux.ts",
  win32: "test/smoke/compile-apps/win.ts",
};

const compileAssetsByPlatform: Record<string, string[]> = {
  darwin: [
    "prebuilds/darwin-arm64/print-it-now.glibc.node",
    "prebuilds/darwin-x64/print-it-now.glibc.node",
  ],
  linux: [
    "prebuilds/linux-x64/print-it-now.musl.node",
    "prebuilds/linux-arm64/print-it-now.musl.node",
    "prebuilds/linux-x64/print-it-now.glibc.node",
    "prebuilds/linux-arm64/print-it-now.glibc.node",
  ],
  win32: [
    "prebuilds/win32-x64/print-it-now.glibc.node",
    "prebuilds/win32-arm64/print-it-now.glibc.node",
    "prebuilds/win32-x64/pdfium.dll",
    "prebuilds/win32-arm64/pdfium.dll",
    "prebuilds/win32-x64/pdfium-version.txt",
    "prebuilds/win32-arm64/pdfium-version.txt",
  ],
};

let consumer: string;
let installed: string;

function prepareConsumer(): void {
  consumer = mkdtempSync(join(tmpdir(), "pin-consumer-"));
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", consumer], {
    cwd: root, encoding: "utf8", shell: process.platform === "win32",
  });
  if (packed.status !== 0) throw new Error(packed.stderr);
  const tarball = JSON.parse(packed.stdout)[0].filename as string;
  const modules = join(consumer, "node_modules");
  mkdirSync(modules);
  const unpacked = spawnSync("tar", ["-xf", join(consumer, tarball), "-C", modules], { encoding: "utf8" });
  if (unpacked.status !== 0) throw new Error(unpacked.stderr);
  installed = join(modules, "print-it-now");
  renameSync(join(modules, "package"), installed);

  // A single-target CI runner lacks foreign prebuilds. Invalid placeholders
  // satisfy static resolution but MUST NOT be loaded. Never modify the repo's
  // publishable prebuilds or substitute a working binary for another ABI.
  for (const rel of Object.values(compileAssetsByPlatform).flat()) {
    const dest = join(installed, rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "foreign-target test placeholder");
  }
  const apps = join(consumer, "test/smoke/compile-apps");
  mkdirSync(apps, { recursive: true });
  for (const name of ["checks.ts", "linux.ts", "macos.ts", "win.ts", "without-platform.ts"]) {
    const source = readFileSync(join(root, "test/smoke/compile-apps", name), "utf8")
      .replaceAll("../../../src/", "../../../node_modules/print-it-now/src/");
    writeFileSync(join(apps, name), source);
  }
  writeFileSync(join(apps, "all.ts"),
    'import "print-it-now/platform"; import { runStandaloneChecks } from "./checks.js"; await runStandaloneChecks();');
}

async function compile(entry: string, outfile: string, minify: boolean, bytecode = false): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(consumer, entry)],
    compile: { outfile },
    minify,
    bytecode,
    format: "esm",
  });
  if (!result.success) {
    const logs = (result.logs ?? []).map(String).join("\n");
    throw new Error(`Bun.build compile of ${entry} failed\n${logs}`);
  }
  const built = existsSync(outfile) ? outfile : `${outfile}.exe`;
  if (!existsSync(built)) {
    throw new Error(`expected ${outfile} or ${outfile}.exe after Bun.build`);
  }
  return built;
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["PRINT_IT_NOW_PDFIUM_PATH"];
  delete env["PRINT_IT_NOW_BACKEND"];
  return env;
}

function runIsolated(exe: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "pin-standalone-"));
  const dest = join(dir, basename(exe));
  copyFileSync(exe, dest);
  try {
    chmodSync(dest, 0o755);
  } catch {
    // Windows.
  }
  const result = spawnSync(dest, {
    cwd: dir,
    encoding: "utf8",
    env: isolatedEnv(),
  });
  rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertRun(exe: string, expectStdout: RegExp): void {
  const result = runIsolated(exe);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(expectStdout);
}

const entry = entryByPlatform[process.platform];
const prebuildDir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
const canCompile = Boolean(entry) && existsSync(prebuildDir);

const outDir = join(root, "test", ".tmp");

describe.skipIf(!canCompile)("bun compile embeds the native addon", () => {
  beforeAll(prepareConsumer);

  afterAll(() => {
    if (consumer) rmSync(consumer, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it(
    "Bun.build({ compile }) with the platform import loads the native backend",
    async () => {
      mkdirSync(outDir, { recursive: true });
      const exe = await compile(entry!, join(outDir, "pin-with-platform"), false);
      assertRun(exe, /All standalone checks passed/);
    },
    { timeout: 60_000 },
  );

  it("Bun.build({ compile, minify: true }) also embeds the addon", async () => {
    mkdirSync(outDir, { recursive: true });
    const exe = await compile(entry!, join(outDir, "pin-with-platform-minify"), true);
    assertRun(exe, /All standalone checks passed/);
  }, { timeout: 60_000 });

  it("minified bytecode compilation embeds the addon", async () => {
    mkdirSync(outDir, { recursive: true });
    const exe = await compile(entry!, join(outDir, "pin-bytecode"), true, true);
    assertRun(exe, /All standalone checks passed/);
  }, { timeout: 60_000 });

  it("the bun build --compile CLI embeds the addon", () => {
    mkdirSync(outDir, { recursive: true });
    const exe = join(outDir, process.platform === "win32" ? "pin-cli.exe" : "pin-cli");
    const result = spawnSync(process.execPath, [
      "build", join(consumer, entry!), "--compile", "--minify", "--outfile", exe,
    ], { cwd: consumer, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    assertRun(exe, /All standalone checks passed/);
  }, { timeout: 60_000 });

  it.skipIf(process.platform !== "win32")("concurrent executables can load PDFium", async () => {
    mkdirSync(outDir, { recursive: true });
    const exe = await compile(entry!, join(outDir, "pin-concurrent"), true);
    const dir = mkdtempSync(join(tmpdir(), "pin-concurrent-"));
    const dest = join(dir, basename(exe));
    copyFileSync(exe, dest);
    const first = Bun.spawn([dest, "--hold"], {
      cwd: dir, env: isolatedEnv(), stdout: "pipe", stderr: "pipe",
    });
    try {
      const reader = first.stdout.getReader();
      const initial = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(initial.value)).toContain("backend=windows");
      // The first process has loaded PDFium and is still alive.
      expect(first.exitCode).toBeNull();
      assertRun(exe, /All standalone checks passed/);
      expect(await first.exited).toBe(0);
    } finally {
      first.kill();
      await first.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 60_000 });

  it("the all-platform entry only loads the current target", async () => {
    mkdirSync(outDir, { recursive: true });
    const exe = await compile("test/smoke/compile-apps/all.ts", join(outDir, "pin-all-platforms"), true);
    assertRun(exe, /All standalone checks passed/);
  }, { timeout: 60_000 });

  it(
    "without the platform import, loadNative fails and names the entry",
    async () => {
      mkdirSync(outDir, { recursive: true });
      const exe = await compile(
        "test/smoke/compile-apps/without-platform.ts",
        join(outDir, "pin-without-platform"),
        true,
      );
      assertRun(exe, /without-platform-ok/);
    },
    { timeout: 60_000 },
  );
});
