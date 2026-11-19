import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isValidPluginId } from "@t3p/api";

/** A scaffold problem the CLI reports as a normal error (no stack trace). */
export class ScaffoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffoldError";
  }
}

/** Resource folder next to dist/ (works from src/ and from dist/ alike). */
export function defaultTemplatesDir(): string {
  return fileURLToPath(new URL("../templates/", import.meta.url));
}

export interface ScaffoldOptions {
  /** Target folder. Created when missing; must be empty when it exists. */
  dir: string;
  /** Plugin id. Default: a slug of the folder name. */
  id?: string;
  /** Display name. Default: the folder name. */
  name?: string;
  /** API stability tier. Default: 1. */
  tier?: 1 | 2 | 3;
  /** Test seam: template folder. */
  templatesDir?: string;
}

export interface ScaffoldResult {
  /** Absolute target folder. */
  dir: string;
  id: string;
  name: string;
  version: string;
  tier: 1 | 2 | 3;
  /** Created files, relative to `dir`, sorted. */
  files: string[];
}

export const SCAFFOLD_VERSION = "0.1.0";

/** `My Plugin` -> `my-plugin`; invalid characters collapse to one dash. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function assertEmptyTarget(dir: string): void {
  if (!existsSync(dir)) return;
  const stat = statSync(dir);
  if (!stat.isDirectory()) throw new ScaffoldError(`${dir} exists and is not a directory`);
  if (readdirSync(dir).length > 0) throw new ScaffoldError(`${dir} is not empty; pick an empty or new folder`);
}

/** Range written for `@t3p/*` deps outside this repo (nothing is published yet, so a placeholder). */
export const EXTERNAL_T3P_RANGE = "^0.0.0";
/** Range written inside this repo's pnpm workspace. */
export const WORKSPACE_T3P_RANGE = "workspace:*";

/**
 * `true` when `dir` (or an ancestor, the folder need not exist yet) is the root of a pnpm
 * workspace that contains `packages/api` named `@t3p/api`, i.e. this repo.
 */
export function insideT3pWorkspace(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(current, "packages", "api", "package.json"), "utf8")) as { name?: unknown };
        if (pkg.name === "@t3p/api") return true;
      } catch {
        // a different workspace: keep looking upwards
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

interface TemplateFile {
  /** Relative to the templates folder, with `.tpl` removed for the target. */
  template: string;
  target: string;
}

function listTemplates(templatesDir: string, prefix = ""): TemplateFile[] {
  if (!existsSync(templatesDir)) throw new ScaffoldError(`templates folder missing: ${templatesDir}`);
  const out: TemplateFile[] = [];
  for (const entry of readdirSync(join(templatesDir, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...listTemplates(templatesDir, rel));
    else if (entry.name.endsWith(".tpl")) out.push({ template: rel, target: rel.slice(0, -".tpl".length) });
  }
  return out.sort((a, b) => a.target.localeCompare(b.target));
}

/**
 * Writes the TypeScript plugin template into `dir`.
 *
 * Everything is rendered in memory first, so a bad id or tier never leaves a
 * half-written folder behind. An existing folder is only used when empty.
 */
export function scaffoldPlugin(options: ScaffoldOptions): ScaffoldResult {
  const dir = resolve(options.dir);
  const templatesDir = options.templatesDir ?? defaultTemplatesDir();
  const id = options.id ?? slugify(basename(dir));
  if (!isValidPluginId(id)) {
    throw new ScaffoldError(`"${id}" is not a valid plugin id; pass --id with lowercase [a-z0-9-] segments (e.g. my-plugin or com.example.my-plugin)`);
  }
  const tier = options.tier ?? 1;
  if (tier !== 1 && tier !== 2 && tier !== 3) throw new ScaffoldError(`--tier must be 1, 2 or 3 (got ${String(tier)})`);
  const name = options.name ?? basename(dir);
  if (name.length === 0 || name.length > 512) throw new ScaffoldError("--name must be 1 to 512 characters");

  assertEmptyTarget(dir);

  const tokens: Record<string, string> = {
    __ID__: id,
    __NAME__: name,
    __NAME_JSON__: JSON.stringify(name),
    __VERSION__: SCAFFOLD_VERSION,
    __TIER__: String(tier),
    __DEP_RANGE__: insideT3pWorkspace(dir) ? WORKSPACE_T3P_RANGE : EXTERNAL_T3P_RANGE,
  };
  const render = (content: string): string => content.replace(/__[A-Z_]+__/g, (token) => tokens[token] ?? token);

  const files = listTemplates(templatesDir);
  const rendered = files.map((file) => ({
    target: file.target,
    content: render(readFileSync(join(templatesDir, file.template), "utf8")),
  }));

  mkdirSync(dir, { recursive: true });
  for (const file of rendered) {
    const target = join(dir, file.target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }

  return {
    dir,
    id,
    name,
    version: SCAFFOLD_VERSION,
    tier,
    files: rendered.map((file) => file.target.replace(/\\/g, "/")),
  };
}

/** Helper for the CLI summary and tests: paths relative to the current directory. */
export function describeFiles(result: ScaffoldResult, cwd = process.cwd()): string[] {
  return result.files.map((file) => relative(cwd, join(result.dir, file)) || file);
}
