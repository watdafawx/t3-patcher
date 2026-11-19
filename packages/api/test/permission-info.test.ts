import { describe, expect, it } from "vitest";

import {
  emptyState,
  GRANT_REQUEST_CHANNEL,
  grantDeclared,
  HIGH_RISK_PERMISSIONS,
  isAllowedInvokeChannel,
  isHighRisk,
  isPrivilegedChannel,
  missingPermissionNames,
  PERMISSION_INFO,
  PERMISSION_NAMES,
  parsePermissions,
  permissionScope,
  revokeNames,
} from "../src/index.js";

describe("permission info", () => {
  it("describes every permission", () => {
    for (const name of PERMISSION_NAMES) {
      expect(PERMISSION_INFO[name].title.length).toBeGreaterThan(3);
      expect(PERMISSION_INFO[name].meaning.length).toBeGreaterThan(10);
    }
  });

  it("hardcodes the high-risk set and marks it high", () => {
    expect([...HIGH_RISK_PERMISSIONS].sort()).toEqual(["embed.youtube", "fs.read", "guard", "main", "patches", "spawn"]);
    expect(Object.isFrozen(HIGH_RISK_PERMISSIONS)).toBe(true);
    for (const name of HIGH_RISK_PERMISSIONS) expect(PERMISSION_INFO[name].risk).toBe("high");
    expect(isHighRisk("rpc")).toBe(false);
  });
});

describe("grantDeclared / revokeNames", () => {
  const declared = parsePermissions(["rpc", "main", { "fs.read": { roots: ["~/.t3/caches"] } }, { spawn: { allow: ["C:/Tools/git.exe"] } }]).set;

  it("grants exactly the declared scope", () => {
    const state = emptyState();
    grantDeclared(state, "p", declared, ["fs.read", "spawn", "rpc"]);
    expect(state.plugins.p!.granted).toEqual(["rpc", { "fs.read": { roots: ["~/.t3/caches"] } }, { spawn: { allow: ["C:/Tools/git.exe"] } }]);
    expect(permissionScope(declared, "fs.read")).toEqual(["~/.t3/caches"]);
    expect(missingPermissionNames(declared, parsePermissions(state.plugins.p!.granted).set)).toEqual(["main"]);
  });

  it("refuses names the manifest does not declare, before writing anything", () => {
    const state = emptyState();
    expect(() => grantDeclared(state, "p", declared, ["rpc", "patches"])).toThrow(/does not declare "patches"/);
    expect(state.plugins.p).toBeUndefined();
  });

  it("revokes", () => {
    const state = emptyState();
    grantDeclared(state, "p", declared, ["rpc", "main"]);
    revokeNames(state, "p", ["main"]);
    expect(state.plugins.p!.granted).toEqual(["rpc"]);
  });
});

describe("privileged channels", () => {
  it("are never allowed through the page bridge's allowlist", () => {
    expect(isPrivilegedChannel(GRANT_REQUEST_CHANNEL)).toBe(true);
    expect(isAllowedInvokeChannel(GRANT_REQUEST_CHANNEL)).toBe(false);
    expect(isAllowedInvokeChannel("t3p:privileged:anything")).toBe(false);
    expect(isAllowedInvokeChannel("t3p:plugins:revoke")).toBe(true);
  });
});
