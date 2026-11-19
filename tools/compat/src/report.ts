import type { FindResult } from "./patches.js";

/** Everything the checker learned, in both the text and the `--json` report. */
export interface CompatReport {
  target: {
    /** Tag when known, else the version the archive reports, else the path. */
    version: string;
    /** How the version was determined. */
    versionSource: "tag" | "archive" | "path";
    commit?: string;
    /** "installer" (downloaded), "installer-file" (local), "asar", "dir", "source". */
    source: "installer" | "installer-file" | "asar" | "dir" | "source";
    /** Human readable detail: the asset name, the archive path, the clone dir. */
    detail: string;
  };
  baseline: { tag: string; commit?: string; rpc: number; slots: number };
  client: { files: number; bytes: number; origin: string } | null;
  patches: {
    findings: FindResult[];
    ok: number;
    broken: number;
    /** Why the patch checks did not run, e.g. a source-only target. */
    skipped?: string;
  };
  rpc: {
    evidence: "server" | "client" | "source";
    baseline: number;
    found: number;
    added: string[];
    removed: string[];
    /** Baseline methods that first-party code names. */
    used: string[];
    /** Used methods that the target no longer has: hard failures. */
    missingUsed: string[];
  };
  slots: {
    baseline: number;
    current: number;
    added: string[];
    removed: string[];
    /** `data-slot` values first-party code selects on. */
    required: string[];
    missingRequired: string[];
    /**
     * True when the anchors came from a source checkout, not the shipped
     * client: a difference is shown but does not fail the run.
     */
    informational?: boolean;
  };
  /** 0 = compatible, 1 = breakage, 2 = usage or input error (the CLI exits with this). */
  ok: boolean;
  notes: string[];
}

const LIST_LIMIT = 12;

function list(items: readonly string[], render: (item: string) => string): string[] {
  const shown = items.slice(0, LIST_LIMIT).map(render);
  if (items.length > LIST_LIMIT) shown.push(`    ... and ${items.length - LIST_LIMIT} more`);
  return shown;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The readable report printed by the CLI. */
export function renderReport(report: CompatReport): string {
  const lines: string[] = [];
  const push = (line = ""): void => {
    lines.push(line);
  };

  push("T3 Patcher compat check");
  push(`  target    ${report.target.version}  (${report.target.source}: ${report.target.detail})`);
  if (report.target.commit) push(`  commit    ${report.target.commit}`);
  push(
    `  baseline  ${report.baseline.tag}${report.baseline.commit ? ` (${report.baseline.commit.slice(0, 7)})` : ""}: ` +
      `${report.baseline.rpc} RPC methods, ${report.baseline.slots} data-slots`,
  );
  if (report.client) {
    push(
      `  client    ${plural(report.client.files, "file")}, ${(report.client.bytes / 1048576).toFixed(1)} MB  (${report.client.origin})`,
    );
  }
  push();

  if (report.patches.skipped) {
    push(`Patches: skipped (${report.patches.skipped})`);
  } else {
    push("Patches (each find must match exactly one chunk)");
    for (const finding of report.patches.findings) {
      if (finding.status === "ok") {
        push(`  ok      ${finding.label.padEnd(20)} ${finding.hits[0]}`);
        continue;
      }
      const where =
        finding.status === "no-match"
          ? "0 chunks"
          : `${finding.hits.length} chunks: ${finding.hits.slice(0, 3).join(", ")}${finding.hits.length > 3 ? ", ..." : ""}`;
      push(`  BROKEN  ${finding.label.padEnd(20)} ${where}`);
      push(`          ${finding.find}`);
      if (finding.detail) push(`          ${finding.detail}`);
      push(`          ${finding.origin}`);
    }
    push(
      `  ${plural(report.patches.findings.length, "find")}: ${report.patches.ok} ok, ${report.patches.broken} broken`,
    );
  }
  push();

  push(`RPC methods (baseline ${report.rpc.baseline}, evidence: ${report.rpc.evidence})`);
  if (report.rpc.removed.length === 0) {
    push("  removed  none");
  } else {
    push(`  removed  ${report.rpc.removed.length}`);
    for (const line of list(report.rpc.removed, (name) =>
      report.rpc.missingUsed.includes(name) ? `    - ${name}   USED BY FIRST-PARTY CODE` : `    - ${name}`,
    )) {
      push(line);
    }
  }
  if (report.rpc.added.length === 0) {
    push("  added    none");
  } else {
    push(`  added    ${report.rpc.added.length}`);
    for (const line of list(report.rpc.added, (name) => `    + ${name}`)) push(line);
  }
  push(
    `  used by first-party code: ${report.rpc.used.length}` +
      (report.rpc.missingUsed.length > 0 ? `, missing: ${report.rpc.missingUsed.join(", ")}` : ", all present"),
  );
  push();

  push(`data-slot anchors (baseline ${report.slots.baseline}, target ${report.slots.current})`);
  if (report.slots.informational) {
    push("  informational: read from a source checkout, not the shipped client; differences do not fail the run");
  }
  if (report.slots.removed.length === 0) {
    push("  removed  none");
  } else {
    push(`  removed  ${report.slots.removed.length}`);
    for (const line of list(report.slots.removed, (slot) =>
      report.slots.missingRequired.includes(slot) ? `    - ${slot}   USED BY FIRST-PARTY CODE` : `    - ${slot}`,
    )) {
      push(line);
    }
  }
  if (report.slots.added.length === 0) {
    push("  added    none");
  } else {
    push(`  added    ${report.slots.added.length}`);
    for (const line of list(report.slots.added, (slot) => `    + ${slot}`)) push(line);
  }
  push(
    `  used by first-party code: ${report.slots.required.length}` +
      (report.slots.missingRequired.length > 0
        ? `, missing: ${report.slots.missingRequired.join(", ")}`
        : ", all present"),
  );
  push();

  for (const note of report.notes) push(`note: ${note}`);
  if (report.notes.length > 0) push();

  const reasons: string[] = [];
  if (report.patches.broken > 0) reasons.push(plural(report.patches.broken, "broken patch find"));
  if (report.rpc.missingUsed.length > 0) reasons.push(`${plural(report.rpc.missingUsed.length, "removed RPC method")} in use`);
  if (report.slots.missingRequired.length > 0) {
    reasons.push(`${plural(report.slots.missingRequired.length, "removed data-slot")} in use`);
  }
  if (report.ok) {
    push(`Result: PASS (${report.target.version} is compatible with ${report.baseline.tag})`);
  } else {
    push(`Result: FAIL (${reasons.join(", ")})`);
  }
  return `${lines.join("\n")}\n`;
}
