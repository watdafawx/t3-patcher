#!/usr/bin/env node

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTree } from "./fsx.js";
import { renderReport } from "./report.js";
import { runCompat, type CompatOptions } from "./run.js";

export const USAGE = `Usage: pnpm --filter @t3p/compat compat -- [target] [options]

Target (one of; a bare argument is treated as --version):
  --version <tag|latest|nightly|path>  tag to fetch, or a local server.asar / client dir
  --asar <path>                        an existing server.asar (or app.asar) to check
  --dir <path>                         an extracted client dir (the one with index.html)
  --installer <path>                   a local Windows NSIS installer (.exe) instead of downloading
  --server-asar <path>                 same as --asar
  --from-git                           with a tag: shallow-clone the source instead of the installer
                                       (skips patch finds; no built client in a source tree)

Fetching:
  --cache <dir>       download/extract cache (default: <repo>/tools/compat/.cache)
  --no-cache          use a throwaway temp dir
  --keep-installer    keep the downloaded installer (removed after extraction by default)
  --seven-zip <path>  7-Zip binary (else T3P_7Z, PATH, Program Files)
  --clean             delete the cache and exit

Checks:
  --patch-file <path>  extra patch finds: JSON array of {name?, plugin?, find | findRegex}
  --no-patches         skip the patch find checks (API surface only)
  --no-plugins         skip plugins/*/patches.json discovery
  --rpc-baseline <path>    default: tools/compat/baseline/rpc-methods.json
  --slots-baseline <path>  default: tools/compat/baseline/data-slots.json
  --update-baseline    record the target as the supported version
  --repo <path>        repository root (default: three levels above this CLI)

Output:
  --json       print the report as JSON
  --quiet      print only the report's last line
  --help       this text

Exit codes: 0 compatible, 1 breakage found, 2 usage or input error.
`;

interface Parsed {
  options: Omit<CompatOptions, "log">;
  json: boolean;
  quiet: boolean;
  clean: boolean;
  help: boolean;
}

class UsageError extends Error {}

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
  return [value, index + 1];
}

export function parseArgs(argv: string[], repoRoot: string): Parsed {
  const options: Omit<CompatOptions, "log"> = {
    repoRoot,
    cacheDir: join(repoRoot, "tools", "compat", ".cache"),
    patchFiles: [],
  };
  let json = false;
  let quiet = false;
  let clean = false;
  let help = false;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    // `pnpm <script> -- --flag` forwards the separator itself.
    if (arg === "--") continue;
    switch (arg) {
      case "--version": {
        const [value, next] = takeValue(argv, index, arg);
        options.version = value;
        index = next;
        break;
      }
      case "--asar":
      case "--server-asar": {
        const [value, next] = takeValue(argv, index, arg);
        options.asar = value;
        index = next;
        break;
      }
      case "--dir": {
        const [value, next] = takeValue(argv, index, arg);
        options.dir = value;
        index = next;
        break;
      }
      case "--installer": {
        const [value, next] = takeValue(argv, index, arg);
        options.installer = value;
        index = next;
        break;
      }
      case "--cache": {
        const [value, next] = takeValue(argv, index, arg);
        options.cacheDir = resolve(value);
        index = next;
        break;
      }
      case "--no-cache": {
        options.cacheDir = mkdtempSync(join(tmpdir(), "t3p-compat-"));
        break;
      }
      case "--keep-installer":
        options.keepInstaller = true;
        break;
      case "--seven-zip": {
        const [value, next] = takeValue(argv, index, arg);
        options.sevenZip = value;
        index = next;
        break;
      }
      case "--from-git":
        options.fromGit = true;
        break;
      case "--patch-file": {
        const [value, next] = takeValue(argv, index, arg);
        options.patchFiles = [...(options.patchFiles ?? []), value];
        index = next;
        break;
      }
      case "--no-plugins":
        options.plugins = false;
        break;
      case "--no-patches":
        options.noPatches = true;
        break;
      case "--rpc-baseline": {
        const [value, next] = takeValue(argv, index, arg);
        options.rpcBaseline = value;
        index = next;
        break;
      }
      case "--slots-baseline": {
        const [value, next] = takeValue(argv, index, arg);
        options.slotsBaseline = value;
        index = next;
        break;
      }
      case "--update-baseline":
        options.updateBaseline = true;
        break;
      case "--repo": {
        const [value, next] = takeValue(argv, index, arg);
        options.repoRoot = resolve(value);
        options.cacheDir = join(options.repoRoot, "tools", "compat", ".cache");
        index = next;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--clean":
        clean = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  if (positional.length > 1) throw new UsageError(`unexpected arguments: ${positional.slice(1).join(" ")}`);
  if (positional.length === 1 && options.version === undefined) options.version = positional[0];

  return { options, json, quiet, clean, help };
}

export function defaultRepoRoot(moduleUrl: string): string {
  // <repo>/tools/compat/dist/cli.mjs -> <repo>
  return resolve(fileURLToPath(new URL("../../../", moduleUrl)));
}

export async function main(argv: string[], moduleUrl: string): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv, defaultRepoRoot(moduleUrl));
  } catch (error) {
    process.stderr.write(`t3p-compat: ${error instanceof Error ? error.message : String(error)}\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (parsed.clean) {
    const failures = removeTree(parsed.options.cacheDir);
    if (failures.length === 0) {
      process.stdout.write(`removed ${parsed.options.cacheDir}\n`);
    } else {
      process.stdout.write(`removed ${parsed.options.cacheDir} except ${failures.length} path(s) still held open:\n`);
      for (const path of failures) process.stdout.write(`  ${path}\n`);
      process.stdout.write("close whatever holds them and run --clean again\n");
    }
    return 0;
  }

  const log = parsed.quiet
    ? { info: () => {}, warn: () => {} }
    : {
        info: (line: string) => process.stderr.write(`${line}\n`),
        warn: (line: string) => process.stderr.write(`warning: ${line}\n`),
      };

  try {
    const report = await runCompat({ ...parsed.options, log });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (parsed.quiet) {
      const last = renderReport(report).trimEnd().split("\n").at(-1) ?? "";
      process.stdout.write(`${last}\n`);
    } else {
      process.stdout.write(renderReport(report));
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`t3p-compat: ${message}\n`);
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2), import.meta.url)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`t3p-compat: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
