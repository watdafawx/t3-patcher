import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { validateManifest, type PluginManifest } from "@t3p/api";
import { build } from "tsdown";

/** A manifest or build problem the CLI reports as a normal error (no stack trace). */
export class PluginBuildError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "PluginBuildError";
  }
}

export interface BuildPluginOptions {
  /** Plugin folder. Default: process.cwd(). */
  root?: string;
  /** Entry relative to root. Default: src/index.ts. */
  entry?: string;
  /** Output folder relative to root. Default: dist. */
  outDir?: string;
  /** Also watch the sources (dev script). The returned close() stops it. */
  watch?: boolean;
}

export interface BuildPluginResult {
  root: string;
  manifest: PluginManifest;
  warnings: string[];
  /** Absolute path of the bundle. */
  output: string;
  /** Stops watch mode. No-op for a normal build. */
  close(): Promise<void>;
}

/** Where the built bundle goes, relative to the plugin folder. */
export const RENDERER_OUTPUT = "dist/renderer.js";

interface ManifestCheck {
  manifest: PluginManifest;
  warnings: string[];
}

/**
 * Reads and validates `<root>/plugin.json`.
 *
 * The folder-name rule of `validateManifest` is not applied: a dev plugin may live in
 * any folder and be linked into `plugins/<id>/` (see `t3p dev`).
 */
export function checkManifest(root: string): ManifestCheck {
  const file = join(root, "plugin.json");
  if (!existsSync(file)) throw new PluginBuildError(`no plugin.json in ${root}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PluginBuildError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const result = validateManifest(raw);
  if (!result.ok) throw new PluginBuildError(`${file} is invalid`, result.errors);
  return { manifest: result.manifest, warnings: result.warnings };
}

/** Bare imports left in the bundle: a plugin must be one self-contained ES module. */
export function findExternalImports(code: string): string[] {
  const patterns = [
    /(?:^|\n)\s*import\s*(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^;]*?\sfrom\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /(?:^|\n)\s*import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) if (match[1]) found.add(match[1]);
  }
  return [...found];
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      listSourceFiles(full, out);
    } else out.push(full);
  }
  return out;
}

/**
 * Validates plugin.json, then bundles one entry into `<outDir>/renderer.js`:
 * ESM, single file, every dependency inlined. Fails when the result still has
 * bare imports (a renderer plugin cannot load `node:*` or an unbundled package).
 */
export async function buildPlugin(options: BuildPluginOptions = {}): Promise<BuildPluginResult> {
  const root = resolve(options.root ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new PluginBuildError(`not a directory: ${root}`);

  const { manifest, warnings } = checkManifest(root);
  if (manifest.renderer !== RENDERER_OUTPUT) {
    warnings.push(`plugin.json "renderer" is ${JSON.stringify(manifest.renderer ?? null)}; t3p-plugin-build writes ${RENDERER_OUTPUT}`);
  }

  const entryRel = options.entry ?? "src/index.ts";
  if (isAbsolute(entryRel)) throw new PluginBuildError("--entry must be relative to the plugin folder");
  const entry = resolve(root, entryRel);
  if (!existsSync(entry)) throw new PluginBuildError(`entry not found: ${relative(root, entry)}`);

  const outDir = resolve(root, options.outDir ?? "dist");
  mkdirSync(outDir, { recursive: true });

  let handle: Awaited<ReturnType<typeof build>>;
  try {
    handle = await build({
      cwd: root,
      config: false,
      entry: { renderer: entry },
      outDir,
      format: ["esm"],
      platform: "neutral",
      target: "es2022",
      dts: false,
      sourcemap: false,
      clean: true,
      report: false,
      // Quiet for a normal build (the CLI prints its own summary); keep progress in watch mode.
      logLevel: options.watch === true ? "info" : "warn",
      // Everything the entry reaches is inlined. @t3p/api is for types; together with
      // the post-build check below, a stray runtime or node: import fails the build.
      deps: { alwaysBundle: [/.*/] },
      outExtensions: () => ({ js: ".js" }),
      ...(options.watch === true ? { watch: true } : {}),
    });
  } catch (error) {
    throw new PluginBuildError(`tsdown failed: ${(error as Error).message}`);
  }

  const output = join(outDir, "renderer.js");
  if (!existsSync(output)) {
    await handle.watch.close().catch(() => undefined);
    const produced = listSourceFiles(outDir).map((file) => relative(root, file));
    throw new PluginBuildError(`tsdown produced no ${RENDERER_OUTPUT}${produced.length > 0 ? ` (wrote: ${produced.join(", ")})` : ""}`);
  }

  const external = findExternalImports(readFileSync(output, "utf8"));
  if (external.length > 0) {
    await handle.watch.close().catch(() => undefined);
    throw new PluginBuildError(`${RENDERER_OUTPUT} still imports external modules: ${external.join(", ")}`, [
      "a renderer plugin is one self-contained ES module; bundle the dependency or remove the import",
    ]);
  }

  return {
    root,
    manifest,
    warnings,
    output,
    close: async () => {
      await handle.watch.close();
    },
  };
}
