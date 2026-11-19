import { createInterface } from "node:readline";

import { describePermission, parsePermissions, permissionNames, type RegistryEntry, searchRegistry } from "@t3p/api";

import { T3pError } from "./errors.js";
import { listPlugins, type PluginListing } from "./plugin-admin.js";
import { fetchRegistryIndex, findEntry, type IndexResult, registryRows, resolveRegistry, type FetchLike } from "./registry.js";
import { installedInfo, installFromRegistry, uninstallPlugin } from "./registry/install.js";

/**
 * `t3p plugins <sub>`: search, info, install, update, uninstall, list (WP-14A). Plain `t3p plugins`
 * still lists the installed plugins (same as `t3p plugins list --installed`). Installs are disabled
 * with nothing granted; the user enables and grants with `t3p enable` / `t3p grant` or in the app.
 */

export interface PluginsCliIo {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  out(line: string): void;
  err(line: string): void;
  /** Asks a question; resolves the answer (empty when stdin closed). */
  prompt(question: string): Promise<string>;
}

export interface PluginsCliFlags {
  json: boolean;
  yes: boolean;
  installed: boolean;
  all: boolean;
  tag?: string[];
}

export const PLUGINS_SUBCOMMANDS = ["list", "search", "info", "install", "update", "uninstall"] as const;

/** Reads one line from stdin (works for a TTY and for piped input). */
export function stdinPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

function printListing(io: PluginsCliIo, list: PluginListing[]): void {
  if (list.length === 0) io.out("no plugins");
  for (const p of list) {
    io.out(`${p.enabled ? "on " : "off"}  ${p.id}${p.version ? `@${p.version}` : ""}${p.valid ? "" : ` (invalid: ${p.errors.join("; ")})`}${p.disabledReason ? ` (disabled: ${p.disabledReason}; re-enable with: t3p enable ${p.id})` : ""}`);
    io.out(`     declared: ${JSON.stringify(p.declared ?? null)}`);
    io.out(`     granted:  ${JSON.stringify(p.granted)}`);
  }
}

function permissionLines(entry: RegistryEntry): string[] {
  const set = parsePermissions(entry.permissions).set;
  const names = permissionNames(set);
  if (names.length === 0) return ["  permissions: none"];
  return ["  permissions (none granted by installing; grant later with t3p grant or in Settings > Plugins):", ...names.map((n) => `    - ${describePermission(n, set)}`)];
}

function entryLines(entry: RegistryEntry, installed: string | null): string[] {
  return [
    `${entry.name} (${entry.id}) ${entry.version}${installed ? `  [installed ${installed}]` : ""}`,
    `  ${entry.description}`,
    `  author:   ${entry.author}`,
    `  homepage: ${entry.homepage}`,
    ...(entry.source ? [`  source:   ${entry.source}`] : []),
    ...(entry.license ? [`  license:  ${entry.license}`] : []),
    ...(entry.tags.length ? [`  tags:     ${entry.tags.join(", ")}`] : []),
    `  download: ${entry.download.url}`,
    `  sha256:   ${entry.download.sha256} (${entry.download.size} bytes)`,
    ...permissionLines(entry),
  ];
}

async function loadIndex(io: PluginsCliIo): Promise<IndexResult> {
  const registry = resolveRegistry({ homeDir: io.homeDir, env: io.env });
  const res = await fetchRegistryIndex({ homeDir: io.homeDir, env: io.env, fetch: io.fetch, registry });
  if (res.source === "cache") io.err(`warning: registry unreachable (${res.error}); using the copy from ${res.fetchedAt}`);
  for (const w of res.warnings) io.err(`warning: ${w}`);
  return res;
}

async function confirm(io: PluginsCliIo, flags: PluginsCliFlags, question: string): Promise<boolean> {
  if (flags.yes) return true;
  const answer = (await io.prompt(`${question} Type y to continue: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function installOne(io: PluginsCliIo, flags: PluginsCliFlags, res: IndexResult, entry: RegistryEntry, mode: "install" | "update"): Promise<boolean> {
  const before = installedInfo(entry.id, io.homeDir);
  if (!flags.json) {
    for (const line of entryLines(entry, before?.version ?? null)) io.out(line);
    io.out(`  registry: ${res.url}`);
    io.out("");
    io.out("This runs code on your PC with your user rights once you enable it. Install only plugins you trust.");
  }
  const verb = mode === "update" ? `Update ${entry.id} ${before?.version ?? "?"} -> ${entry.version}?` : `Install ${entry.id} ${entry.version} (disabled, no permissions granted)?`;
  if (!(await confirm(io, flags, verb))) {
    io.err("cancelled; nothing changed");
    return false;
  }
  const result = await installFromRegistry({
    homeDir: io.homeDir,
    entry,
    registryUrl: res.url,
    fetch: io.fetch,
    allowInsecureLocal: resolveRegistry({ homeDir: io.homeDir, env: io.env }).allowInsecureLocal,
    mode,
  });
  if (flags.json) io.out(JSON.stringify(result));
  else if (result.updated) io.out(`updated ${result.id} ${result.previousVersion ?? "?"} -> ${result.version} (sha256 verified); settings and grants kept. Restart T3 Code to load it.`);
  else {
    io.out(`installed ${result.id} ${result.version} (sha256 verified) to ${result.dir}, disabled, no permissions granted.`);
    io.out(`Next: t3p enable ${result.id}${parsePermissions(entry.permissions).errors.length === 0 && entry.permissions.length > 0 ? ` and t3p grant ${result.id} <permission>` : ""}, or use Settings > Plugins in T3 Code.`);
  }
  return true;
}

/** Runs `t3p plugins [sub] ...`. Returns the exit code. */
export async function runPluginsCommand(positionals: string[], flags: PluginsCliFlags, io: PluginsCliIo): Promise<number> {
  const [sub, ...args] = positionals;
  const one = (): string => {
    if (args.length !== 1) throw new UsageError(`plugins ${sub} needs exactly one <id>`);
    return args[0]!;
  };
  if (sub === undefined || (sub === "list" && flags.installed)) {
    if (sub === "list" && args.length > 0) throw new UsageError("plugins list takes no arguments");
    const list = listPlugins(io.homeDir);
    if (flags.json) io.out(JSON.stringify(list, null, 2));
    else printListing(io, list);
    return 0;
  }
  switch (sub) {
    case "list":
    case "search": {
      if (sub === "list" && args.length > 0) throw new UsageError("plugins list takes no arguments");
      const res = await loadIndex(io);
      const rows = registryRows(res.index, io.homeDir);
      const shown = searchRegistry(res.index.plugins, sub === "search" ? args.join(" ") : "", flags.tag ?? []);
      const keep = new Set(shown.map((e) => e.id));
      const out = rows.filter((r) => keep.has(r.entry.id));
      if (flags.json) {
        io.out(JSON.stringify(out.map((r) => ({ id: r.entry.id, name: r.entry.name, version: r.entry.version, installed: r.installed, state: r.state, tags: r.entry.tags, description: r.entry.description })), null, 2));
        return 0;
      }
      if (out.length === 0) io.out(sub === "search" ? `no plugin matches "${args.join(" ")}"` : "the registry is empty");
      for (const r of out) {
        const mark = r.devLink ? "dev link" : r.state === "update" ? `update ${r.installed} -> ${r.entry.version}` : r.state === "installed" ? `installed ${r.installed}` : "";
        io.out(`${r.entry.id.padEnd(20)} ${r.entry.version.padEnd(10)} ${mark ? `[${mark}] ` : ""}${r.entry.name}: ${r.entry.description.length > 80 ? `${r.entry.description.slice(0, 77)}...` : r.entry.description}`);
      }
      return 0;
    }
    case "info": {
      const id = one();
      const res = await loadIndex(io);
      const entry = findEntry(res.index, id);
      if (!entry) throw new T3pError(`${id} is not in the registry (${res.url})`);
      const installed = installedInfo(id, io.homeDir)?.version ?? null;
      if (flags.json) io.out(JSON.stringify({ ...entry, installed }, null, 2));
      else for (const line of entryLines(entry, installed)) io.out(line);
      return 0;
    }
    case "install": {
      const id = one();
      const res = await loadIndex(io);
      const entry = findEntry(res.index, id);
      if (!entry) throw new T3pError(`${id} is not in the registry (${res.url}); try t3p plugins search`);
      return (await installOne(io, flags, res, entry, "install")) ? 0 : 1;
    }
    case "update": {
      if (flags.all === args.length > 0) throw new UsageError("plugins update needs <id> or --all");
      const res = await loadIndex(io);
      const rows = registryRows(res.index, io.homeDir);
      let targets = rows.filter((r) => r.state === "update" && !r.devLink);
      if (!flags.all) {
        const id = args[0]!;
        const row = rows.find((r) => r.entry.id === id);
        if (!row) throw new T3pError(`${id} is not in the registry (${res.url})`);
        if (!row.installed) throw new T3pError(`${id} is not installed; use t3p plugins install ${id}`);
        if (row.devLink) throw new T3pError(`${id} is a t3p dev link; updates do not touch it`);
        if (row.state !== "update") {
          io.out(`${id} ${row.installed} is up to date (registry: ${row.entry.version})`);
          return 0;
        }
        targets = [row];
      }
      if (targets.length === 0) {
        io.out("all registry plugins are up to date");
        return 0;
      }
      let failed = false;
      for (const row of targets) {
        try {
          if (!(await installOne(io, flags, res, row.entry, "update"))) failed = true;
        } catch (error) {
          failed = true;
          io.err(`${row.entry.id}: ${(error as Error).message}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "uninstall": {
      const id = one();
      const info = installedInfo(id, io.homeDir);
      if (!flags.json) io.out(`Uninstall ${id}${info?.version ? ` ${info.version}` : ""}: removes its folder and its enabled/grant entry. Its settings are kept.`);
      if (!(await confirm(io, flags, `Uninstall ${id}?`))) {
        io.err("cancelled; nothing changed");
        return 1;
      }
      const result = uninstallPlugin({ homeDir: io.homeDir, id });
      if (flags.json) io.out(JSON.stringify(result));
      else io.out(`uninstalled ${id}; restart T3 Code if it was running`);
      return 0;
    }
    default:
      throw new UsageError(`unknown plugins subcommand "${sub}" (expected ${PLUGINS_SUBCOMMANDS.join(", ")})`);
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
