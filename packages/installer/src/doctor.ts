import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CAPTURE_NAMES, CRASH_LOOP_REASON, INTERNALS_STATUS_FILE, type InternalsStatusFile, parseState, pluginState } from "@t3p/api";

import { errorMessage } from "./errors.js";
import { describeFuses, fusesAreSafe, readFusesFromExe } from "./fuses.js";
import { junctionInfo, layoutPaths } from "./layout.js";
import { installKey, readManifest, sha256File } from "./manifest.js";
import { status } from "./status.js";
import { SUPPORTED_VERSIONS, type DoctorCheck, type DoctorOpts, type SignatureCheck } from "./types.js";

async function verifyAuthenticode(exePath: string, platform: NodeJS.Platform): Promise<SignatureCheck> {
  if (platform !== "win32") return { ok: true, detail: "skipped (not Windows)" };
  const escaped = exePath.replace(/'/g, "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = (result.stdout ?? "").trim();
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? output ?? `exit ${result.status}`;
    return { ok: false, detail: `Get-AuthenticodeSignature failed: ${detail}` };
  }
  const [statusText, subject] = output.split("|");
  const status = (statusText ?? "").trim();
  return {
    ok: status === "Valid",
    detail: subject && subject.trim() ? `${status || "unknown"} (${subject.trim()})` : status || "no output",
  };
}

function tail(file: string, lines: number): string | null {
  try {
    const text = readFileSync(file, "utf8").trimEnd();
    if (!text) return "";
    return text.split(/\r?\n/).slice(-lines).join(" | ");
  } catch {
    return null;
  }
}

/**
 * Tier 2 captures (WP-3D): one check per capture from `internals-status.json`, which the main runtime
 * writes. captured and fallback are healthy (fallback says which substitute runs); failed and pending
 * are not a reason to fail doctor, because the app may simply not have started yet, but failed is flagged.
 */
function internalsChecks(file: string): DoctorCheck[] {
  let parsed: InternalsStatusFile | null = null;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as InternalsStatusFile;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.captures) {
    return CAPTURE_NAMES.map((name) => ({ name: `internal: ${name}`, ok: true, detail: "no status yet (start T3 Code once)" }));
  }
  return CAPTURE_NAMES.map((name) => {
    const entry = parsed!.captures[name];
    if (!entry) return { name: `internal: ${name}`, ok: true, detail: "no status yet" };
    return { name: `internal: ${name}`, ok: entry.state !== "failed", detail: `${entry.state}: ${entry.detail}` };
  });
}

/** Plugins the crash-loop guard disabled (state.json `disabledReason: "crash-loop"`). */
function crashLoopCheck(home: string): DoctorCheck {
  const disabled: string[] = [];
  try {
    const { state } = parseState(JSON.parse(readFileSync(join(home, ".t3-patcher", "state.json"), "utf8")));
    for (const id of Object.keys(state.plugins)) if (pluginState(state, id).disabledReason === CRASH_LOOP_REASON) disabled.push(id);
  } catch {
    // no state file: nothing was disabled
  }
  return disabled.length === 0
    ? { name: "crash-loop guard", ok: true, detail: "no plugin disabled by the guard" }
    : { name: "crash-loop guard", ok: true, detail: `warning: disabled after repeated failed starts: ${disabled.join(", ")} (re-enable with: t3p enable <id>)` };
}

/**
 * Health checks for one install. Every check is {name, ok, detail}; the CLI
 * exits non-zero when any of them fails.
 */
export async function doctor(opts: DoctorOpts = {}): Promise<{ checks: DoctorCheck[] }> {
  const home = opts.homeDir ?? homedir();
  const platform = opts.platform ?? process.platform;
  const checks: DoctorCheck[] = [];

  const report = await status(opts);
  const install = report.install;

  checks.push({
    name: "install found",
    ok: install !== undefined,
    detail: install
      ? `${install.installDir} (${install.channel}, ${install.version ?? "unknown version"})`
      : report.reasons.join("; ") || "no T3 Code install found",
  });

  if (install) {
    try {
      const fuses = await (opts.readFuses ?? readFusesFromExe)(install.exePath);
      checks.push({ name: "fuses safe", ok: fusesAreSafe(fuses), detail: describeFuses(fuses) });
    } catch (error) {
      checks.push({ name: "fuses safe", ok: false, detail: `could not read fuses: ${errorMessage(error)}` });
    }
  } else {
    checks.push({ name: "fuses safe", ok: false, detail: "skipped (no install)" });
  }

  const versionSupported = install?.version != null && SUPPORTED_VERSIONS.includes(install.version);
  checks.push({
    name: "version supported",
    ok: versionSupported,
    detail: install?.version ? `${install.version} (supported: ${SUPPORTED_VERSIONS.join(", ")})` : "version unreadable or no install",
  });

  checks.push({
    name: "layout patched",
    ok: report.layout === "patched",
    detail: report.layout === "patched" ? "patched" : `${report.layout}: ${report.reasons.join("; ")}`,
  });

  const entry = install ? (readManifest(home)?.installs[installKey(install.installDir)] ?? null) : null;
  const paths = install ? layoutPaths(install.installDir) : null;

  if (!entry || !paths) {
    checks.push({ name: "_app.asar hash equals manifest", ok: false, detail: "no manifest entry" });
  } else if (!existsSync(paths.originalAsar)) {
    checks.push({ name: "_app.asar hash equals manifest", ok: false, detail: `${paths.originalAsar} is missing` });
  } else {
    const actual = sha256File(paths.originalAsar);
    checks.push({
      name: "_app.asar hash equals manifest",
      ok: actual === entry.originalAsarSha256,
      detail: actual === entry.originalAsarSha256 ? actual : `expected ${entry.originalAsarSha256}, found ${actual}`,
    });
  }

  if (!entry || !paths) {
    checks.push({ name: "junction", ok: false, detail: "no manifest entry" });
  } else if (!entry.junction) {
    checks.push({ name: "junction", ok: true, detail: "no junction (resources/app.asar.unpacked is absent)" });
  } else {
    const info = junctionInfo(paths.resourcesDir);
    const ok = info.present && info.isSymlink && info.targetExists;
    checks.push({
      name: "junction",
      ok,
      detail: ok
        ? `${info.path} -> ${info.target}`
        : !info.present
          ? `${info.path} is missing`
          : !info.isSymlink
            ? `${info.path} is not a junction`
            : `${info.path} points at ${info.target}, which is missing`,
    });
  }

  const runtimeMain = join(home, ".t3-patcher", "runtime", "main.cjs");
  let runtimeOk = false;
  let runtimeDetail = `${runtimeMain} is missing`;
  try {
    runtimeOk = statSync(runtimeMain).isFile();
    if (runtimeOk) runtimeDetail = runtimeMain;
  } catch {
    runtimeOk = false;
  }
  checks.push({ name: "runtime present", ok: runtimeOk, detail: runtimeDetail });

  const verify = opts.verifySignature ?? verifyAuthenticode;
  if (!install) {
    checks.push({ name: "exe signature", ok: false, detail: "skipped (no install)" });
  } else {
    try {
      const signature = await verify(install.exePath, platform);
      checks.push({ name: "exe signature", ok: signature.ok, detail: signature.detail });
    } catch (error) {
      checks.push({ name: "exe signature", ok: false, detail: `signature check failed: ${errorMessage(error)}` });
    }
  }

  checks.push(crashLoopCheck(home));
  checks.push(...internalsChecks(join(home, ".t3-patcher", INTERNALS_STATUS_FILE)));

  const shimLog = tail(join(home, ".t3-patcher", "logs", "shim.log"), 5);
  checks.push({
    name: "shim log",
    ok: true,
    detail: shimLog === null ? "no shim log yet" : shimLog === "" ? "shim log is empty" : shimLog,
  });

  return { checks };
}
