import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { readRpcBaseline, readSlotsBaseline, writeRpcBaseline, writeSlotsBaseline } from "./baseline.js";
import { loadClientFromAsar, loadClientFromDir, loadServerSources, type ClientBundle, type ServerSources } from "./bundle.js";
import { extractServerAsar } from "./extract.js";
import { removeTree } from "./fsx.js";
import { cloneTag, headCommit } from "./git.js";
import { diffMethods, usedMethods, type BaselineMethod } from "./methods.js";
import { corePatchFinds, pluginPatchFinds, readPatchFile, scanFinds, serverGuardFinding, serverMcpFinding, type FindEntry } from "./patches.js";
import { download, installerUrl, pickInstallerAsset, releaseAssets, resolveTag, type Log } from "./release.js";
import { productSourceFiles, readTexts } from "./repo.js";
import type { CompatReport } from "./report.js";
import { diffSlots, extractSlots, requiredSlots } from "./slots.js";
import { methodsFromContractsSource, slotsFromWebSource } from "./source.js";
import { readAsarIdentity } from "./target.js";

export interface CompatOptions {
  repoRoot: string;
  /** Tag, `latest`, `nightly`, or a path to an asar/client dir. */
  version?: string;
  asar?: string;
  dir?: string;
  installer?: string;
  serverAsar?: string;
  /** With a tag: `git clone --depth 1 --branch <tag>` instead of the installer. */
  fromGit?: boolean;
  cacheDir: string;
  keepInstaller?: boolean;
  updateBaseline?: boolean;
  patchFiles?: string[];
  /** Skip the patch find checks (API-surface-only run). */
  noPatches?: boolean;
  plugins?: boolean;
  rpcBaseline?: string;
  slotsBaseline?: string;
  sevenZip?: string;
  log: Log;
}

export interface BaselinePaths {
  rpc: string;
  slots: string;
}

export function baselinePaths(repoRoot: string): BaselinePaths {
  const compatDir = join(repoRoot, "tools", "compat", "baseline");
  return { rpc: join(compatDir, "rpc-methods.json"), slots: join(compatDir, "data-slots.json") };
}

interface ResolvedTarget {
  version: string;
  versionSource: "tag" | "archive" | "path";
  commit?: string;
  source: "installer" | "installer-file" | "asar" | "dir" | "source";
  detail: string;
  bundle?: ClientBundle;
  serverSources?: ServerSources;
  /** A source checkout, when the installer was not used. */
  sourceTree?: { root: string };
  notes: string[];
}

function targetFromAsar(path: string): ResolvedTarget {
  const identity = readAsarIdentity(path);
  const bundle = loadClientFromAsar(path);
  return {
    version: identity.version ?? path,
    versionSource: identity.version ? "archive" : "path",
    commit: identity.commit,
    source: "asar",
    detail: `${path}${identity.name ? ` (${identity.name})` : ""}`,
    bundle,
    serverSources: loadServerSources({ asarPath: path, bundle }),
    notes: [],
  };
}

function targetFromDir(path: string): ResolvedTarget {
  const bundle = loadClientFromDir(path);
  return {
    version: path,
    versionSource: "path",
    source: "dir",
    detail: path,
    bundle,
    serverSources: loadServerSources({ bundle }),
    notes: ["dir target: RPC methods come from client call sites, not the server bundle"],
  };
}

function classify(value: string): "asar" | "dir" | null {
  const path = resolve(value);
  if (!existsSync(path)) return null;
  return value.toLowerCase().endsWith(".asar") ? "asar" : "dir";
}

/**
 * The Windows installer for `tag`, cached as `server.asar`. A local
 * `--installer` is used as-is; otherwise the release asset is downloaded.
 */
async function serverAsarForTag(
  tag: string,
  options: CompatOptions,
): Promise<{ path: string; source: "installer" | "installer-file"; detail: string }> {
  const log = options.log;
  const dir = join(options.cacheDir, tag);
  const cached = join(dir, "server.asar");
  if (existsSync(cached)) {
    log.info(`using cached server.asar: ${cached}`);
    return { path: cached, source: "installer", detail: cached };
  }

  let installer = options.installer ? resolve(options.installer) : undefined;
  let detail = installer ?? "";
  if (installer && !existsSync(installer)) throw new Error(`installer not found: ${installer}`);

  if (!installer) {
    const names = await releaseAssets(tag, log);
    const asset = pickInstallerAsset(names);
    if (!asset) {
      throw new Error(
        `release ${tag} has no Windows installer asset (${names.length} assets; try --from-git or --server-asar)`,
      );
    }
    detail = asset;
    log.info(`fetching ${asset} from ${tag}`);
    const result = await download(installerUrl(tag, asset), join(dir, asset), log, (received, total) => {
      const percent = total > 0 ? ` (${Math.round((received / total) * 100)}%)` : "";
      log.info(`  ${(received / 1048576).toFixed(1)} MB${percent}`);
    });
    installer = result.path;
  }

  const extracted = extractServerAsar({
    installer,
    outFile: cached,
    workDir: join(dir, "work"),
    sevenZip: options.sevenZip,
    log,
  });
  if (!options.keepInstaller && !options.installer) {
    removeTree(installer);
    log.info("removed the downloaded installer (keep it with --keep-installer)");
  }
  return { path: extracted, source: options.installer ? "installer-file" : "installer", detail };
}

async function resolveTarget(options: CompatOptions): Promise<ResolvedTarget> {
  const explicitAsar = options.serverAsar ?? options.asar;
  if (explicitAsar) return targetFromAsar(resolve(explicitAsar));
  if (options.dir) return targetFromDir(resolve(options.dir));
  if (!options.version) {
    throw new Error("no target: pass --version <tag|latest|nightly|path>, --asar <path> or --dir <path>");
  }

  const kind = classify(options.version);
  if (kind === "asar") return targetFromAsar(resolve(options.version));
  if (kind === "dir") return targetFromDir(resolve(options.version));

  const resolved = await resolveTag(options.version, options.log);

  if (options.fromGit) {
    const root = cloneTag(resolved.tag, join(options.cacheDir, `src-${resolved.tag}`), options.log);
    if (!existsSync(join(root, "packages", "contracts", "src"))) {
      throw new Error(`${root}: not a T3 Code checkout (packages/contracts/src missing)`);
    }
    options.log.info("source target: patch finds are skipped (a source tree holds no built client)");
    return {
      version: resolved.tag,
      versionSource: "tag",
      commit: headCommit(root),
      source: "source",
      detail: `${root} (git clone)`,
      sourceTree: { root },
      notes: ["source target: patch finds skipped, RPC methods read from packages/contracts/src"],
    };
  }

  const server = await serverAsarForTag(resolved.tag, options);
  const identity = readAsarIdentity(server.path);
  const bundle = loadClientFromAsar(server.path);
  const notes: string[] = [];
  if (identity.version && !identity.version.startsWith(resolved.tag.replace(/^v/, ""))) {
    notes.push(`archive reports version ${identity.version} but the tag is ${resolved.tag}`);
  }
  return {
    version: resolved.tag,
    versionSource: "tag",
    commit: identity.commit,
    source: server.source,
    detail: `${server.detail}${identity.version ? ` (app version ${identity.version})` : ""}`,
    bundle,
    serverSources: loadServerSources({ asarPath: server.path, bundle }),
    notes,
  };
}

function collectFinds(options: CompatOptions): FindEntry[] {
  const entries = corePatchFinds();
  if (options.plugins !== false) entries.push(...pluginPatchFinds(join(options.repoRoot, "plugins")));
  for (const file of options.patchFiles ?? []) entries.push(...readPatchFile(resolve(file)));
  return entries;
}

/** Runs the whole check and returns the report; the CLI decides how to print it. */
export async function runCompat(options: CompatOptions): Promise<CompatReport> {
  const log = options.log;
  const paths = baselinePaths(options.repoRoot);
  const rpcFile = options.rpcBaseline ?? paths.rpc;
  const slotsFile = options.slotsBaseline ?? paths.slots;
  const rpcBaseline = readRpcBaseline(rpcFile);
  const slotsBaseline = readSlotsBaseline(slotsFile);
  const baselineNames = rpcBaseline.methods.map((method) => method.name);

  const target = await resolveTarget(options);
  log.info(`target: ${target.version} (${target.source})`);

  const findings = target.bundle && !options.noPatches ? scanFinds(target.bundle.chunks, collectFinds(options)) : [];
  const serverGuard = target.bundle && !options.noPatches ? serverGuardFinding(target.serverSources?.chunks) : null;
  if (serverGuard) findings.push(serverGuard);
  const serverMcp = target.bundle && !options.noPatches ? serverMcpFinding(target.serverSources?.chunks) : null;
  if (serverMcp) findings.push(serverMcp);
  const broken = findings.filter((finding) => finding.status !== "ok").length;

  let evidence: "server" | "client" | "source" = "server";
  let added: string[] = [];
  let removed: string[] = [];
  let found = 0;
  let sourceMethods: BaselineMethod[] | undefined;
  if (target.sourceTree) {
    evidence = "source";
    sourceMethods = methodsFromContractsSource(join(target.sourceTree.root, "packages", "contracts", "src"));
    const names = new Set(sourceMethods.map((method) => method.name));
    removed = baselineNames.filter((name) => !names.has(name));
    added = [...names].filter((name) => !baselineNames.includes(name)).sort();
    found = baselineNames.length - removed.length;
  } else if (target.serverSources) {
    evidence = target.serverSources.evidence;
    const diff = diffMethods(baselineNames, target.serverSources);
    added = diff.added;
    removed = diff.removed;
    found = diff.found;
  }

  const currentSlots = target.bundle
    ? extractSlots(target.bundle)
    : target.sourceTree
      ? slotsFromWebSource(join(target.sourceTree.root, "apps", "web", "src"))
      : [];
  const slotDiff = diffSlots(slotsBaseline.slots, currentSlots);
  const slotsInformational = target.bundle === undefined;

  const productTexts = readTexts(productSourceFiles(options.repoRoot));
  const used = usedMethods(productTexts, new Set(baselineNames));
  const missingUsed = used.filter((name) => removed.includes(name));
  const required = requiredSlots(productTexts);
  const missingRequired = slotsInformational ? [] : required.filter((slot) => slotDiff.removed.includes(slot));

  const report: CompatReport = {
    target: {
      version: target.version,
      versionSource: target.versionSource,
      commit: target.commit,
      source: target.source,
      detail: target.detail,
    },
    baseline: {
      tag: rpcBaseline.tag,
      commit: rpcBaseline.commit,
      rpc: rpcBaseline.methods.length,
      slots: slotsBaseline.slots.length,
    },
    client: target.bundle
      ? {
          files: target.bundle.chunks.size + target.bundle.html.size,
          bytes: target.bundle.bytes,
          origin: target.bundle.origin,
        }
      : null,
    patches: {
      findings,
      ok: findings.length - broken,
      broken,
      skipped: target.bundle
        ? options.noPatches
          ? "--no-patches"
          : undefined
        : "a source tree holds no built client",
    },
    rpc: {
      evidence,
      baseline: rpcBaseline.methods.length,
      found,
      added,
      removed,
      used,
      missingUsed,
    },
    slots: {
      baseline: slotsBaseline.slots.length,
      current: currentSlots.length,
      added: slotDiff.added,
      removed: slotDiff.removed,
      required,
      missingRequired,
      informational: slotsInformational || undefined,
    },
    ok: broken === 0 && missingUsed.length === 0 && missingRequired.length === 0,
    notes: target.notes,
  };

  if (options.updateBaseline) updateBaselines({ report, rpcFile, slotsFile, evidence, sourceMethods, rpcBaseline, currentSlots, log });

  return report;
}

interface UpdateInput {
  report: CompatReport;
  rpcFile: string;
  slotsFile: string;
  evidence: "server" | "client" | "source";
  sourceMethods?: BaselineMethod[];
  rpcBaseline: { tag: string; commit?: string; methods: BaselineMethod[] };
  currentSlots: string[];
  log: Log;
}

/**
 * `--update-baseline` records the target as the new supported version. The RPC
 * list is only written when it is authoritative: the contracts source, or a
 * bundle diff that removed nothing (additions from a bundle are a heuristic).
 */
function updateBaselines(input: UpdateInput): void {
  const { report, rpcFile, slotsFile, evidence, sourceMethods, rpcBaseline, currentSlots, log } = input;
  const tag = report.target.versionSource === "tag" ? report.target.version : rpcBaseline.tag;
  const commit = report.target.commit ?? rpcBaseline.commit;

  let methods: BaselineMethod[] | undefined = sourceMethods;
  if (!methods && evidence !== "client" && report.rpc.removed.length === 0) {
    const existing = new Map(rpcBaseline.methods.map((method) => [method.name, method]));
    for (const name of report.rpc.added) existing.set(name, { name, kind: "unary" });
    methods = [...existing.values()];
  }
  if (methods) {
    writeRpcBaseline(rpcFile, { tag, commit, source: `t3p-compat --update-baseline (${evidence} evidence)`, methods });
    log.info(`wrote ${rpcFile} (${methods.length} methods)`);
  } else {
    log.warn(`not updating ${rpcFile}: this target cannot produce a complete method list`);
  }

  if (currentSlots.length > 0 && !report.slots.informational) {
    writeSlotsBaseline(slotsFile, { tag, commit, slots: currentSlots });
    log.info(`wrote ${slotsFile} (${currentSlots.length} slots)`);
  } else if (report.slots.informational) {
    log.warn(`not updating ${slotsFile}: a source checkout has no shipped client to read slots from`);
  } else {
    log.warn(`not updating ${slotsFile}: no data-slots were read from the target`);
  }
}
