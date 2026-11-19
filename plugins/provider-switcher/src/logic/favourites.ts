import type { Selection } from "./types.js";

/**
 * `favourites` setting: one `instanceId:model` per line. Blank lines and `#` comments are skipped,
 * duplicates keep their first position, and a line without a non-empty part on both sides is ignored.
 */
export function parseFavourites(text: string): Selection[] {
  const out: Selection[] = [];
  const seen = new Set<string>();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const providerInstanceId = line.slice(0, at).trim();
    const model = line.slice(at + 1).trim();
    if (providerInstanceId === "" || model === "" || model.includes(":")) continue;
    const key = `${providerInstanceId}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerInstanceId, model });
  }
  return out;
}
