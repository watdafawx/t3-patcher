import { GRANT_REQUEST_CHANNEL } from "@t3p/api";
import { describe, expect, it, vi } from "vitest";

import { createBridge } from "../src/bridge.js";
import { type ClickLike, grantRequestFromClick, installGrantClicks } from "../src/grant-clicks.js";

/** Minimal element: `closest` finds the grant button if `attrs` carries the attribute. */
function el(attrs: Record<string, string>): { closest(sel: string): unknown; getAttribute(n: string): string | null } {
  const node = {
    closest: (sel: string) => (sel === "[data-t3p-grant-request]" && "data-t3p-grant-request" in attrs ? node : null),
    getAttribute: (n: string) => attrs[n] ?? null,
  };
  return node;
}

const click = (attrs: Record<string, string>, extra: Partial<ClickLike> = {}): ClickLike => ({ isTrusted: true, button: 0, target: el(attrs), ...extra });

describe("grantRequestFromClick", () => {
  it("reads a trusted click on a grant button", () => {
    expect(grantRequestFromClick(click({ "data-t3p-grant-request": "notes", "data-t3p-grant-perms": "rpc,guard" }))).toEqual({ id: "notes", permissions: ["rpc", "guard"] });
    expect(grantRequestFromClick(click({ "data-t3p-grant-request": "notes", "data-t3p-grant-perms": "*" }))).toEqual({ id: "notes", permissions: "*" });
  });

  it("ignores untrusted clicks (el.click(), dispatchEvent from page scripts)", () => {
    expect(grantRequestFromClick(click({ "data-t3p-grant-request": "notes" }, { isTrusted: false }))).toBeNull();
  });

  it("ignores other buttons, bad ids, unknown permissions and non-elements", () => {
    expect(grantRequestFromClick(click({ "data-t3p-grant-request": "notes" }, { button: 2 }))).toBeNull();
    expect(grantRequestFromClick(click({ other: "x" }))).toBeNull();
    expect(grantRequestFromClick(click({ "data-t3p-grant-request": "../evil" }))).toBeNull();
    expect(grantRequestFromClick(click({ "data-t3p-grant-request": "notes", "data-t3p-grant-perms": "rpc,root" }))).toBeNull();
    expect(grantRequestFromClick({ isTrusted: true, target: null })).toBeNull();
  });
});

describe("installGrantClicks", () => {
  it("sends the privileged channel only for trusted clicks, through the private ipcRenderer", () => {
    let listener: ((e: ClickLike) => void) | null = null;
    const target = { addEventListener: vi.fn((_t: string, fn: (e: ClickLike) => void) => void (listener = fn)), removeEventListener: vi.fn() };
    const ipc = { invoke: vi.fn(async () => ({ status: "cancelled" })) };
    const remove = installGrantClicks(target, ipc);
    expect(target.addEventListener).toHaveBeenCalledWith("click", expect.any(Function), true);
    listener!(click({ "data-t3p-grant-request": "notes", "data-t3p-grant-perms": "rpc" }, { isTrusted: false }));
    expect(ipc.invoke).not.toHaveBeenCalled();
    listener!(click({ "data-t3p-grant-request": "notes", "data-t3p-grant-perms": "rpc" }));
    expect(ipc.invoke).toHaveBeenCalledWith(GRANT_REQUEST_CHANNEL, { id: "notes", permissions: ["rpc"] });
    remove();
    expect(target.removeEventListener).toHaveBeenCalled();
  });
});

describe("page bridge", () => {
  it("refuses the grant-request channel (no path from page or plugin code)", async () => {
    const ipc = { invoke: vi.fn(async () => true), on: vi.fn(), removeListener: vi.fn() };
    const bridge = createBridge(ipc);
    await expect(bridge.invoke(GRANT_REQUEST_CHANNEL, { id: "notes", permissions: "*" })).rejects.toThrow(/not allowed/);
    await expect(bridge.invoke("t3p:privileged:grant-request ", {})).rejects.toThrow(/not allowed/);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});
