#!/usr/bin/env node
import { parseArgs } from "node:util";

import { buildPlugin, PluginBuildError, RENDERER_OUTPUT } from "./build.js";

const USAGE = `t3p-plugin-build - build a T3 Patcher renderer plugin

Usage:
  t3p-plugin-build [--root DIR] [--entry FILE] [--out-dir DIR] [--watch]

Options:
  --root DIR      plugin folder holding plugin.json (default: current directory)
  --entry FILE    TypeScript entry relative to the plugin folder (default: src/index.ts)
  --out-dir DIR   output folder relative to the plugin folder (default: dist)
  --watch         rebuild when the sources change (for \`t3p dev\`)
  -h, --help      show this help

The plugin.json is validated first (same rules as @t3p/api). The bundle is one
ES module at ${RENDERER_OUTPUT}, with every dependency inlined; a leftover
external import fails the build.`;

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        root: { type: "string" },
        entry: { type: "string" },
        "out-dir": { type: "string" },
        watch: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`t3p-plugin-build: ${(error as Error).message}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    const result = await buildPlugin({
      root: parsed.values.root,
      entry: parsed.values.entry,
      outDir: parsed.values["out-dir"],
      watch: parsed.values.watch,
    });
    console.log(`built ${result.manifest.id}@${result.manifest.version}: ${RENDERER_OUTPUT} (tier ${result.manifest.tier})`);
    for (const warning of result.warnings) console.log(`  warning: ${warning}`);
    if (parsed.values.watch) {
      console.log("watching for changes (Ctrl+C stops)");
      await new Promise<void>((resolve) => {
        const stop = () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      await result.close();
    }
    return 0;
  } catch (error) {
    if (error instanceof PluginBuildError) {
      console.error(`t3p-plugin-build: ${error.message}`);
      for (const detail of error.details) console.error(`  - ${detail}`);
    } else {
      console.error(`t3p-plugin-build: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`t3p-plugin-build: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });
