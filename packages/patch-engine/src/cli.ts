#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { applyPatches } from "./apply.js";
import { planPatches } from "./plan.js";
import type {
  AppliedPatch,
  ChunkSet,
  FailedPatch,
  Patch,
  Replacement,
} from "./types.js";

const USAGE = `Usage: t3p-patch-test <clientDir> <patchFile> [--json]

  clientDir   directory of extracted client files; every *.js and *.mjs below
              it is treated as a chunk (chunk name = relative path, forward slashes)
  patchFile   .mjs/.js whose default export is Patch[], or a .json array of
              {plugin, find | findRegex, replacement | replacement[] with
              {match | matchRegex, replace}}
  --json      print {applied, failed} instead of the per-patch report

Exit codes: 0 all patches applied, 1 some patch failed, 2 usage or input error.
`;

interface RegexSource {
  source: string;
  flags?: string;
}

interface JsonReplacement {
  match?: string;
  matchRegex?: RegexSource;
  replace?: string;
}

interface JsonPatch {
  plugin?: string;
  find?: string;
  findRegex?: RegexSource;
  replacement?: JsonReplacement | JsonReplacement[];
}

function toRegExp(value: RegexSource): RegExp {
  return new RegExp(value.source, value.flags ?? "");
}

function toFind(patch: JsonPatch, index: number): string | RegExp {
  if (patch.findRegex) {
    if (typeof patch.findRegex.source !== "string") {
      throw new Error(`patch ${index}: findRegex.source must be a string`);
    }
    return toRegExp(patch.findRegex);
  }
  if (typeof patch.find !== "string") {
    throw new Error(`patch ${index}: needs a string "find" or a "findRegex"`);
  }
  return patch.find;
}

function toReplacement(
  value: JsonReplacement,
  patchIndex: number,
  replacementIndex: number,
): Replacement {
  if (typeof value.replace !== "string") {
    throw new Error(
      `patch ${patchIndex}: replacement ${replacementIndex} needs a string "replace"`,
    );
  }
  if (value.matchRegex) {
    if (typeof value.matchRegex.source !== "string") {
      throw new Error(
        `patch ${patchIndex}: replacement ${replacementIndex} matchRegex.source must be a string`,
      );
    }
    return { match: toRegExp(value.matchRegex), replace: value.replace };
  }
  if (typeof value.match !== "string") {
    throw new Error(
      `patch ${patchIndex}: replacement ${replacementIndex} needs a string "match" or a "matchRegex"`,
    );
  }
  return { match: value.match, replace: value.replace };
}

function fromJsonPatches(value: unknown): Patch[] {
  if (!Array.isArray(value)) {
    throw new Error("patch JSON must be an array of patches");
  }

  return value.map((raw: unknown, index: number) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`patch ${index}: must be an object`);
    }
    const patch = raw as JsonPatch;
    if (typeof patch.plugin !== "string" || patch.plugin.length === 0) {
      throw new Error(`patch ${index}: needs a plugin id`);
    }
    if (patch.replacement === undefined) {
      throw new Error(`patch ${index}: needs a "replacement"`);
    }
    const replacements = Array.isArray(patch.replacement)
      ? patch.replacement
      : [patch.replacement];

    return {
      plugin: patch.plugin,
      find: toFind(patch, index),
      replacement: replacements.map((entry, replacementIndex) =>
        toReplacement(entry, index, replacementIndex),
      ),
    };
  });
}

async function loadPatches(patchFile: string): Promise<Patch[]> {
  const extension = extname(patchFile).toLowerCase();

  if (extension === ".json") {
    const text = readFileSync(patchFile, "utf8");
    return fromJsonPatches(JSON.parse(text) as unknown);
  }

  if (extension === ".mjs" || extension === ".js" || extension === ".cjs") {
    const module = (await import(pathToFileURL(patchFile).href)) as {
      default?: unknown;
    };
    const value = module.default;
    if (!Array.isArray(value)) {
      throw new Error(
        `${patchFile}: default export must be a Patch[] array`,
      );
    }
    return value as Patch[];
  }

  throw new Error(
    `${patchFile}: unsupported patch file extension (expected .json, .mjs or .js)`,
  );
}

function readChunks(clientDir: string): ChunkSet {
  const chunks = new Map<string, string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (extension !== ".js" && extension !== ".mjs") continue;
      const name = relative(clientDir, fullPath).split(sep).join("/");
      chunks.set(name, readFileSync(fullPath, "utf8"));
    }
  };

  walk(clientDir);
  return chunks;
}

function describeFailure(failure: FailedPatch): string {
  const where = failure.chunk ? ` [${failure.chunk}]` : "";
  return `FAIL ${failure.reason}  ${failure.plugin}: ${failure.find}${where}  ${failure.detail}`;
}

function describeApplied(applied: AppliedPatch): string {
  const plural = applied.replacements === 1 ? "replacement" : "replacements";
  return `OK   ${applied.chunk} (${applied.replacements} ${plural})  ${applied.plugin}: ${applied.find}`;
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");

  if (positional.some((arg) => arg.startsWith("-"))) {
    process.stderr.write(USAGE);
    return 2;
  }

  if (positional.length !== 2) {
    process.stderr.write(USAGE);
    return 2;
  }

  const clientDir = resolve(positional[0]!);
  const patchFile = resolve(positional[1]!);

  let chunks: ChunkSet;
  let patches: Patch[];
  try {
    chunks = readChunks(clientDir);
    patches = await loadPatches(patchFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`t3p-patch-test: ${message}\n`);
    return 2;
  }

  const plan = planPatches(chunks, patches);
  const applied: AppliedPatch[] = [];
  const failed: FailedPatch[] = [...plan.failed];

  for (const [chunkName, chunkPatches] of plan.byChunk) {
    const source = chunks.get(chunkName);
    if (source === undefined) continue;
    const result = applyPatches(chunkName, source, chunkPatches);
    applied.push(...result.applied);
    failed.push(...result.failed);
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ applied, failed }, null, 2)}\n`,
    );
  } else {
    for (const entry of applied) process.stdout.write(`${describeApplied(entry)}\n`);
    for (const entry of failed) process.stdout.write(`${describeFailure(entry)}\n`);
    if (applied.length === 0 && failed.length === 0) {
      process.stdout.write("no patches applied, none failed\n");
    }
  }

  return failed.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`t3p-patch-test: ${message}\n`);
      process.exitCode = 2;
    });
}
