import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getBackendInfo } from "../../src/index.js";
import { loadNative, resetNativeCache } from "../../src/internal.js";
import { loadEmbedded } from "../../src/platform/register.js";

const root = join(dirname(import.meta.path), "../..");

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

function currentPrebuild(): string | undefined {
  const dir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
  const candidates =
    process.platform === "linux"
      ? ["print-it-now.glibc.node", "print-it-now.musl.node"]
      : ["print-it-now.glibc.node"];
  return candidates.map((name) => join(dir, name)).find((path) => existsSync(path));
}

describe("print-it-now/platform package contract", () => {
  it("exports TypeScript entries so Bun sees the original imports", () => {
    const pkg = JSON.parse(read("package.json")) as {
      exports: Record<string, string | Record<string, string>>;
    };
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      bun: "./src/index.ts",
      import: "./dist/index.js",
      require: "./dist/index.cjs",
    });
    expect(pkg.exports["./platform"]).toBe("./src/platform/index.ts");
    expect(pkg.exports["./platform/win"]).toBe("./src/platform/win.ts");
    expect(pkg.exports["./platform/macos"]).toBe("./src/platform/macos.ts");
    expect(pkg.exports["./platform/linux"]).toBe("./src/platform/linux.ts");
  });
});

describe("loadEmbedded", () => {
  afterEach(() => {
    resetNativeCache();
  });

  it("preserves the loader error for a missing embedded addon", () => {
    expect(() => loadEmbedded(join(root, "missing-addon.node"))).toThrow();
  });

  const prebuild = currentPrebuild();

  it.skipIf(!prebuild)("dlopens the current prebuild via require", async () => {
    resetNativeCache();
    loadEmbedded(prebuild!);
    expect(typeof loadNative().describe).toBe("function");
    const info = await getBackendInfo();
    if (process.platform === "win32") {
      expect(info.backend).toBe("windows");
      expect(info.pdfiumVersion).toBeTruthy();
    } else {
      expect(info.backend).toBe("cups");
    }
  });
});
