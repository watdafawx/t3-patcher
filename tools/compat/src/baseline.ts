import { readFileSync, writeFileSync } from "node:fs";
import type { BaselineMethod, MethodKind } from "./methods.js";

/** Committed baseline: the RPC methods the supported release exposes. */
export interface RpcBaseline {
  tag: string;
  commit?: string;
  /** Where the list came from, for the report. */
  source?: string;
  methods: BaselineMethod[];
}

/** Committed baseline: the `data-slot` values the supported release renders. */
export interface SlotsBaseline {
  tag: string;
  commit?: string;
  slots: string[];
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: cannot read baseline (${message})`);
  }
}

function requireTag(value: object, file: string): string {
  const tag = (value as { tag?: unknown }).tag;
  if (typeof tag !== "string" || tag.length === 0) throw new Error(`${file}: missing "tag"`);
  return tag;
}

function optionalString(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

export function readRpcBaseline(file: string): RpcBaseline {
  const raw = readJson(file);
  if (typeof raw !== "object" || raw === null) throw new Error(`${file}: expected an object`);
  const tag = requireTag(raw, file);
  const methods = (raw as { methods?: unknown }).methods;
  if (!Array.isArray(methods)) throw new Error(`${file}: missing "methods" array`);
  const out: BaselineMethod[] = methods.map((entry, index) => {
    if (typeof entry === "string") return { name: entry, kind: "unary" as MethodKind };
    const record = entry as { name?: unknown; kind?: unknown };
    if (typeof record.name !== "string") throw new Error(`${file}: method ${index} has no name`);
    const kind = record.kind === "stream" ? "stream" : "unary";
    return { name: record.name, kind };
  });
  return {
    tag,
    commit: optionalString(raw, "commit"),
    source: optionalString(raw, "source"),
    methods: out,
  };
}

export function readSlotsBaseline(file: string): SlotsBaseline {
  const raw = readJson(file);
  if (typeof raw !== "object" || raw === null) throw new Error(`${file}: expected an object`);
  const tag = requireTag(raw, file);
  const slots = (raw as { slots?: unknown }).slots;
  if (!Array.isArray(slots) || slots.some((slot) => typeof slot !== "string")) {
    throw new Error(`${file}: missing "slots" array of strings`);
  }
  return {
    tag,
    commit: optionalString(raw, "commit"),
    slots: slots as string[],
  };
}

export function writeRpcBaseline(file: string, value: RpcBaseline): void {
  const methods = [...value.methods].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(
    file,
    `${JSON.stringify({ tag: value.tag, commit: value.commit, source: value.source, count: methods.length, methods }, null, 2)}\n`,
    "utf8",
  );
}

export function writeSlotsBaseline(file: string, value: SlotsBaseline): void {
  const slots = [...new Set(value.slots)].sort();
  writeFileSync(
    file,
    `${JSON.stringify({ tag: value.tag, commit: value.commit, count: slots.length, slots }, null, 2)}\n`,
    "utf8",
  );
}
