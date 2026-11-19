import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { emptyState, type PatcherStateJson, parseState } from "@t3p/api";

import type { Logger } from "../log.js";

const MAX_STATE = 1024 * 1024;

/** Reads state.json. Missing file = nothing enabled. Malformed = fail closed (logged). */
export function readStateFile(file: string, log: Logger): PatcherStateJson {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return emptyState();
  }
  if (text.length > MAX_STATE) {
    log.warn(`state.json is larger than ${MAX_STATE} bytes; ignoring it`);
    return emptyState();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    log.warn(`state.json is not valid JSON; nothing enabled: ${String(error)}`);
    return emptyState();
  }
  const { state, errors } = parseState(raw);
  for (const error of errors) log.warn(`state.json: ${error}`);
  return state;
}

/**
 * Writes state.json atomically. Only the plugin manager calls it (enable/disable and load order);
 * it never adds a grant. Re-read the file immediately before changing it, so edits made by the CLI
 * in between are kept.
 */
export function writeStateFile(file: string, state: PatcherStateJson): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}
`, "utf8");
  renameSync(tmp, file);
}
