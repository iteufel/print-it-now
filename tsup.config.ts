import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    // Built but deliberately absent from package.json's `exports`, so the test
    // suite can reach the pure option-mapping code without it becoming API.
    internal: "src/internal.ts",
  },
  format: ["esm", "cjs"],
  target: "node18",
  platform: "node",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
  // `shims` gives the ESM output a working `__dirname` and the CJS output a
  // working `import.meta.url`, which the native binding loader relies on.
  shims: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
  external: ["node-gyp-build"],
});
