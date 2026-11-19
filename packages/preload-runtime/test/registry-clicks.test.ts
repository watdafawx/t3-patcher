import { GRANT_REQUEST_CHANNEL, REGISTRY_REQUEST_CHANNEL } from "@t3p/api";
import { describe, expect, it, vi } from "vitest";

import { createBridge } from "../src/bridge.js";
import { type ClickLike, installGrantClicks, registryRequestFromClick } from "../src/grant-clicks.js";

/** Minimal element: `closest` finds itself for any attribute selector it carries. */
function el(attrs: Record<string, string>): { closest(sel: string): unknown; getAttribute(n: string): string | null } {
  const node = {
    closest: (sel: string) => {
      const m = /^\[([a-z0-9-]+)\]$/.exec(sel);
      return m && m[1]! in attrs ? node : null;
    },
    getAttribute: (n: string) => attrs[n] ?? null,
  };
  return node;
}

const click = (attrs: Record<string, string>, extra: Partial<ClickLike> = {}): ClickLike => ({ isTrusted: true, button: 0, target: el(attrs), ...extra });
const btn = (action: string, id: string) => ({ "data-t3p-registry-action": action, "data-t3p-registry-id": id });

describe("registryRequestFromClick", () => {
  it("reads install, update and uninstall from a trusted click", () => {
    for (const action of ["install", "update", "uninstall"]) expect(registryRequestFromClick(click(btn(action, "notes")))).toEqual({ action, id: "notes" });
  });

  it("ignores untrusted clicks, other buttons, unknown actions and bad ids", () => {
    expect(registryRequestFromClick(click(btn("install", "notes"), { isTrusted: false }))).toBeNull();
    expect(registryRequestFromClick(click(btn("install", "notes"), { button: 1 }))).toBeNull();
    expect(registryRequestFromClick(click(btn("enable", "notes")))).toBeNull();
    expect(registryRequestFromClick(click(btn("install", "../evil")))).toBeNull();
    expect(registryRequestFromClick(click({ "data-t3p-registry-action": "install" }))).toBeNull();
    expect(registryRequestFromClick({ isTrusted: true, target: null })).toBeNull();
  });
});

describe("installGrantClicks (registry)", () => {
  it("sends the registry channel only for trusted clicks, with nothing but action and id", () => {
    let listener: ((e: ClickLike) => void) | null = null;
    const target = { addEventListener: vi.fn((_t: string, fn: (e: ClickLike) => void) => void (listener = fn)), removeEventListener: vi.fn() };
    const ipc = { invoke: vi.fn(async () => ({ status: "cancelled" })) };
    installGrantClicks(target, ipc);
    listener!(click({ ...btn("install", "notes"), "data-url": "https://evil.example/x.zip" }, { isTrusted: false }));
    expect(ipc.invoke).not.toHaveBeenCalled();
    listener!(click({ ...btn("install", "notes"), "data-url": "https://evil.example/x.zip" }));
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    expect(ipc.invoke).toHaveBeenCalledWith(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "notes" });
    // a grant button wins when both attributes are present (one request per click)
    listener!(click({ ...btn("uninstall", "notes"), "data-t3p-grant-request": "notes" }));
    expect(ipc.invoke).toHaveBeenLastCalledWith(GRANT_REQUEST_CHANNEL, { id: "notes", permissions: "*" });
    expect(ipc.invoke).toHaveBeenCalledTimes(2);
  });

  it("the page bridge refuses the registry request channel", async () => {
    const ipc = { invoke: vi.fn(async () => true), on: vi.fn(), removeListener: vi.fn() };
    const bridge = createBridge(ipc);
    await expect(bridge.invoke(REGISTRY_REQUEST_CHANNEL, { action: "install", id: "notes" })).rejects.toThrow(/not allowed/);
    await expect(bridge.invoke(`${REGISTRY_REQUEST_CHANNEL} `, {})).rejects.toThrow(/not allowed/);
    expect(ipc.invoke).not.toHaveBeenCalled();
    await bridge.invoke("t3p:registry:index", {});
    expect(ipc.invoke).toHaveBeenCalledWith("t3p:registry:index", {});
  });
});
