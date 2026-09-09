import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relative) {
  return readFileSync(join(root, relative), "utf8");
}

describe("print-it-now/platform entries", () => {
  it("are exported as TypeScript so Bun sees the original imports", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.exports["./platform"], "./src/platform/index.ts");
    assert.equal(pkg.exports["./platform/win"], "./src/platform/win.ts");
    assert.equal(pkg.exports["./platform/macos"], "./src/platform/macos.ts");
    assert.equal(pkg.exports["./platform/linux"], "./src/platform/linux.ts");
  });

  it("macos statically requires both Darwin prebuilds", () => {
    const source = read("src/platform/macos.ts");
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/darwin-arm64\/node\.napi\.node"\)/);
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/darwin-x64\/node\.napi\.node"\)/);
  });

  it("linux statically requires glibc and musl prebuilds for both arches", () => {
    const source = read("src/platform/linux.ts");
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/linux-x64\/node\.napi\.glibc\.node"\)/);
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/linux-arm64\/node\.napi\.glibc\.node"\)/);
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/linux-x64\/node\.napi\.musl\.node"\)/);
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/linux-arm64\/node\.napi\.musl\.node"\)/);
  });

  it("win embeds pdfium.dll with type:file and reads it with Bun.file", () => {
    const source = read("src/platform/win.ts");
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/win32-x64\/node\.napi\.node"\)/);
    assert.match(source, /require\("\.\.\/\.\.\/prebuilds\/win32-arm64\/node\.napi\.node"\)/);
    assert.match(
      source,
      /from "\.\.\/\.\.\/prebuilds\/win32-x64\/pdfium\.dll" with \{ type: "file" \}/,
    );
    assert.match(
      source,
      /from "\.\.\/\.\.\/prebuilds\/win32-arm64\/pdfium\.dll" with \{ type: "file" \}/,
    );
    assert.match(source, /from "bun"/);
    assert.match(source, /file\(embeddedPath\)\.arrayBuffer\(\)/);
  });

  it("the all-platforms entry pulls in win, macos and linux", () => {
    const source = read("src/platform/index.ts");
    assert.match(source, /import "\.\/win\.js"/);
    assert.match(source, /import "\.\/macos\.js"/);
    assert.match(source, /import "\.\/linux\.js"/);
  });

  it("the binding and the platform loader share the same cache key", () => {
    const key = /Symbol\.for\("print-it-now\.nativeAddon"\)/;
    assert.match(read("src/binding.ts"), key);
    assert.match(read("src/platform/register.ts"), key);
  });
});
