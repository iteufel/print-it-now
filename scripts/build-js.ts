/**
 * Bundles the published JS with the Bun.build API, then emits .d.ts via the
 * TypeScript compiler API.
 *
 * Two JS formats because the package is dual ESM/CJS. Declarations stay with
 * tsc because Bun's bundler does not write them.
 */

import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dir, "..");

const shared = {
  target: "node" as const,
  sourcemap: "linked" as const,
  packages: "external" as const,
};

async function bundle(
  entry: string,
  options: Pick<Bun.BuildConfig, "format" | "naming" | "banner" | "plugins">,
): Promise<void> {
  const result = await Bun.build({
    ...shared,
    ...options,
    entrypoints: [join(root, entry)],
    outdir: join(root, "dist"),
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

function emitDeclarations(): void {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.build.json");
  if (configPath === undefined) {
    throw new Error("tsconfig.build.json not found");
  }
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const emit = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emit.diagnostics];
  if (diagnostics.length === 0) return;
  for (const diagnostic of diagnostics) {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = ts.getLineAndCharacterOfPosition(
        diagnostic.file,
        diagnostic.start,
      );
      console.error(`${diagnostic.file.fileName}:${line + 1}:${character + 1} ${text}`);
    } else {
      console.error(text);
    }
  }
  process.exit(1);
}

rmSync(join(root, "dist"), { recursive: true, force: true });

await bundle("src/index.ts", { format: "esm", naming: "[name].js" });
await bundle("src/index.ts", {
  format: "cjs",
  naming: "[name].cjs",
  // Bun otherwise freezes import.meta.url to the source machine in CJS.
  banner: "const __printItNowModuleUrl = require('node:url').pathToFileURL(__filename).href;",
  plugins: [{
    name: "runtime-cjs-module-url",
    setup(build) {
      build.onLoad({ filter: /binding\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replaceAll("import.meta.url", "__printItNowModuleUrl"),
        loader: "ts",
      }));
    },
  }],
});
await bundle("src/cli.ts", {
  format: "esm",
  naming: "[name].js",
  banner: "#!/usr/bin/env node",
});

const cliPath = join(root, "dist/cli.js");
const cli = readFileSync(cliPath, "utf8");
if (!cli.startsWith("#!")) {
  writeFileSync(cliPath, `#!/usr/bin/env node\n${cli}`);
}

emitDeclarations();
