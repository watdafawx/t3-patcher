#!/usr/bin/env node
import { relative } from "node:path";
import { parseArgs } from "node:util";

import { describeFiles, scaffoldPlugin, ScaffoldError } from "./scaffold.js";

const USAGE = `create-t3p-plugin - scaffold a T3 Patcher plugin

Usage:
  create-t3p-plugin <dir> [--id x] [--name x] [--tier 1]

Options:
  --id ID     plugin id (default: a slug of the folder name)
  --name NAME display name (default: the folder name)
  --tier N    highest API stability tier: 1 stable, 2 internals, 3 raw patches (default: 1)
  -h, --help  show this help

The folder must be new or empty. It gets plugin.json, src/index.ts, tsconfig.json,
package.json (build/dev scripts), README.md and .gitignore.

Next:
  cd <dir>
  pnpm install
  pnpm build
  t3p dev .`;

// Own function so parseArgs infers the option types from the literal below.
function parseCli(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      tier: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function main(argv: string[]): number {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    console.error(`create-t3p-plugin: ${(error as Error).message}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }

  const [dir, ...extra] = parsed.positionals;
  if (!dir || extra.length > 0) {
    console.error(dir ? `create-t3p-plugin: unexpected argument "${extra[0]}"` : "create-t3p-plugin: missing <dir>");
    console.error(USAGE);
    return 2;
  }

  let tier: 1 | 2 | 3 | undefined;
  if (parsed.values.tier !== undefined) {
    const value = Number(parsed.values.tier);
    if (value !== 1 && value !== 2 && value !== 3) {
      console.error("create-t3p-plugin: --tier must be 1, 2 or 3");
      return 2;
    }
    tier = value;
  }

  try {
    const result = scaffoldPlugin({ dir, id: parsed.values.id, name: parsed.values.name, tier });
    console.log(`created ${relative(process.cwd(), result.dir) || "."} (id ${result.id}, tier ${result.tier})`);
    for (const file of describeFiles(result)) console.log(`  ${file}`);
    console.log("next:");
    console.log(`  cd ${relative(process.cwd(), result.dir) || "."}`);
    console.log("  pnpm install");
    console.log("  pnpm build");
    console.log("  t3p dev .");
    return 0;
  } catch (error) {
    if (error instanceof ScaffoldError) {
      console.error(`create-t3p-plugin: ${error.message}`);
    } else {
      console.error(`create-t3p-plugin: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
