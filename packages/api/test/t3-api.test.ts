import { describe, expect, it } from "vitest";

import {
  effectivePermissions,
  grantPermission,
  isAllowedInvokeChannel,
  parsePermissions,
  parseState,
  T3NotImplementedError,
  T3PermissionError,
  T3QuotaError,
  T3_API_VERSION,
  emptyState,
} from "../src/index.js";

describe("rpc permission", () => {
  it("parses as a bare permission and rejects options", () => {
    expect(parsePermissions(["rpc"]).set.rpc).toBe(true);
    expect(parsePermissions([{ rpc: {} }]).errors.length).toBeGreaterThan(0);
  });

  it("is effective only when declared and granted", () => {
    const declared = parsePermissions(["rpc"]).set;
    expect(effectivePermissions(declared, parsePermissions([]).set).rpc).toBeFalsy();
    expect(effectivePermissions(declared, parsePermissions(["rpc"]).set).rpc).toBe(true);
    expect(effectivePermissions(parsePermissions([]).set, parsePermissions(["rpc"]).set).rpc).toBeFalsy();
  });

  it("can be granted through state", () => {
    const next = grantPermission(emptyState(), "p", "rpc");
    expect(next.plugins.p?.granted).toContain("rpc");
  });
});

describe("loadOrder in state.json", () => {
  it("parses a string array, drops invalid ids and duplicates", () => {
    expect(parseState({ version: 1, plugins: {}, loadOrder: ["b", "a"] }).state.loadOrder).toEqual(["b", "a"]);
    expect(parseState({ version: 1, plugins: {}, loadOrder: ["ok", 3, "Bad Id", "ok"] }).state.loadOrder).toEqual(["ok"]);
    expect(parseState({ version: 1, plugins: {} }).state.loadOrder).toBeUndefined();
  });
});

describe("new IPC channels and errors", () => {
  it("allows the storage and plugin management channels", () => {
    for (const c of ["t3p:storage:read", "t3p:storage:write", "t3p:plugins:set-enabled", "t3p:plugins:set-load-order"]) {
      expect(isAllowedInvokeChannel(c)).toBe(true);
    }
  });

  it("error types carry their data", () => {
    const n = new T3NotImplementedError("t3.ui.toast", "WP-3D");
    expect(n.owner).toBe("WP-3D");
    expect(n.message).toContain("WP-3D");
    const p = new T3PermissionError("p", "rpc");
    expect([p.plugin, p.permission]).toEqual(["p", "rpc"]);
    expect(new T3QuotaError("p", 10).limitBytes).toBe(10);
    expect(T3_API_VERSION).toBe("1.0");
  });
});

import { apiCompatible, isT3Error, T3PermissionError, validateManifest } from "../src/index.js";

describe("api compatibility and error codes", () => {
  it("apiCompatible: same major, plugin minor not newer", () => {
    expect(apiCompatible(undefined, "1.0")).toBe(true);
    expect(apiCompatible("1.x", "1.3")).toBe(true);
    expect(apiCompatible("1.2", "1.1")).toBe(false);
    expect(apiCompatible("2", "1.0")).toBe(false);
  });
  it("manifest t3pApi defaults to 1 and rejects junk", () => {
    const base = { id: "a", version: "1.0.0", tier: 1, t3Versions: ["*"] };
    const ok = validateManifest(base);
    expect(ok.ok && ok.manifest.t3pApi).toBe("1");
    for (const v of ["1", "1.x", "1.2"]) expect(validateManifest({ ...base, t3pApi: v }).ok, v).toBe(true);
    expect(validateManifest({ ...base, t3pApi: "one" }).ok).toBe(false);
  });
  it("isT3Error matches by code, not identity", () => {
    expect(isT3Error(new T3PermissionError("p", "rpc"), "permission")).toBe(true);
    expect(isT3Error({ name: "T3PermissionError", code: "permission" }, "permission")).toBe(true);
    expect(isT3Error(new Error("x"))).toBe(false);
  });
});
