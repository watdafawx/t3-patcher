import { describe, expect, it } from "vitest";

import { effectivePermissions, grantPermission, parsePermissions, permissionsToJson, revokePermission } from "../src/index.js";

describe("embed.youtube permission", () => {
  it("needs declare and grant, round-trips, grants and revokes", () => {
    const declared = parsePermissions(["main", "embed.youtube"]);
    expect(declared.errors).toEqual([]);
    expect(permissionsToJson(declared.set)).toEqual(["main", "embed.youtube"]);
    expect(effectivePermissions(declared.set, { main: true })["embed.youtube"]).toBeUndefined();
    expect(effectivePermissions({ main: true }, { "embed.youtube": true })["embed.youtube"]).toBeUndefined();
    expect(effectivePermissions(declared.set, { "embed.youtube": true, main: true })["embed.youtube"]).toBe(true);
    const state = grantPermission({ version: 1, plugins: {} }, "media", "embed.youtube");
    expect(JSON.stringify(state)).toContain('"embed.youtube"');
    revokePermission(state, "media", "embed.youtube");
    expect(JSON.stringify(state)).not.toContain('"embed.youtube"');
  });
});
