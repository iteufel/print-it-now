import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";

const root = join(dirname(import.meta.path), "../..");
const esm = join(root, "dist/index.js");
const cjs = join(root, "dist/index.cjs");
const built = existsSync(esm) && existsSync(cjs);

describe.skipIf(!built)("published ESM and CJS bundles", () => {
  it("the published CLI runs under Node", () => {
    const result = spawnSync("node", [join(root, "dist/cli.js"), "backend", "--json"], {
      cwd: tmpdir(), encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).backend).toBe(process.platform === "win32" ? "windows" : "cups");
  });

  for (const format of ["esm", "cjs"] as const) {
    it(`${format} loads the native backend from an unrelated working directory`, () => {
      const entry = format === "esm" ? esm : cjs;
      const expression = format === "esm"
        ? `await import(${JSON.stringify(pathToFileURL(entry).href)})`
        : `require(${JSON.stringify(entry)})`;
      const result = spawnSync("node", [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `const pkg = ${expression}; pkg.getBackendInfo().then(info => {
          if (info.backend !== ${JSON.stringify(process.platform === "win32" ? "windows" : "cups")}) throw new Error(JSON.stringify(info));
        }).catch(error => { console.error(error); process.exitCode = 1; });`,
      ], { cwd: tmpdir(), encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
  }

  it("the ESM build loads the native addon", async () => {
    const pkg = await import(esm) as typeof import("../../src/index.js");
    const info = await pkg.getBackendInfo();
    expect(typeof info.backend).toBe("string");
    expect(info.backend.length).toBeGreaterThan(0);
  });

  it("the CJS build loads the native addon", async () => {
    const req = createRequire(import.meta.url);
    const pkg = req("../../dist/index.cjs") as {
      getBackendInfo: () => Promise<{ backend: string }>;
    };
    const info = await pkg.getBackendInfo();
    expect(typeof info.backend).toBe("string");
    expect(info.backend.length).toBeGreaterThan(0);
  });

  it("does not freeze the build-machine source path into the CJS bundle", () => {
    const source = readFileSync(cjs, "utf8");
    expect(source.includes(join(root, "src"))).toBe(false);
  });

  it("does not resolve print-it-now at module load in either bundle", () => {
    for (const file of [esm, cjs]) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("var require_ = ")).toBe(false);
      expect(source.includes("createRequire(join(packageRoot()")).toBe(false);
    }
  });
});
