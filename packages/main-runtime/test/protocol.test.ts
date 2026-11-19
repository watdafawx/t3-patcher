import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { nullLogger } from "../src/log.js";
import { injectRendererScript, RENDERER_SCRIPT_URL } from "../src/protocol/html.js";
import { serveVirtual } from "../src/protocol/virtual.js";
import { installProtocolWrap, type RewriteDeps, wrapProtocolHandler } from "../src/protocol/wrap.js";

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'";
const HTML = '<!doctype html><html><head><meta charset="utf-8"><script type="module" crossorigin src="/assets/index-abc.js"></script></head><body></body></html>';

function appHandler(): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/index.html")
      return new Response(HTML, { headers: { "content-type": "text/html", "content-security-policy": CSP, "content-length": String(HTML.length) } });
    if (path === "/assets/index-abc.js") return new Response("console.log('hello');", { headers: { "content-type": "text/javascript", "content-security-policy": CSP, "x-custom": "1" } });
    if (path === "/assets/other.js") return new Response("other();", { headers: { "content-type": "text/javascript" } });
    if (path === "/logo.png") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    return new Response(null, { status: 404 });
  };
}

function deps(over: Partial<RewriteDeps> = {}): RewriteDeps {
  return {
    log: nullLogger,
    injectHtml: true,
    hasPatchesFor: (name) => name === "assets/index-abc.js",
    transform: (_name, source) => source.replace("hello", "patched"),
    virtual: () => new Response("virtual", { status: 200 }),
    ...over,
  };
}
const req = (path: string, init?: RequestInit): Request => new Request(`t3code://app${path}`, init);

describe("protocol rewrite", () => {
  it("returns untouched responses as the same object (no buffering)", async () => {
    const original = appHandler();
    let seen: Response | null = null;
    const handler = wrapProtocolHandler(async (r) => (seen = await original(r)), deps());
    const res = await handler(req("/assets/other.js"));
    expect(res).toBe(seen);
    const png = await handler(req("/logo.png"));
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("injects the renderer script before the first script, keeps CSP, drops content-length", async () => {
    const res = await wrapProtocolHandler(appHandler(), deps())(req("/"));
    const text = await res.text();
    expect(text.indexOf(RENDERER_SCRIPT_URL)).toBeGreaterThan(0);
    expect(text.indexOf(RENDERER_SCRIPT_URL)).toBeLessThan(text.indexOf("/assets/index-abc.js"));
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("does not inject in safe mode", async () => {
    const res = await wrapProtocolHandler(appHandler(), deps({ injectHtml: false }))(req("/"));
    expect(await res.text()).toBe(HTML);
  });

  it("patches only chunks with assigned patches and preserves headers", async () => {
    const res = await wrapProtocolHandler(appHandler(), deps())(req("/assets/index-abc.js"));
    expect(await res.text()).toBe("console.log('patched');");
    expect(res.headers.get("x-custom")).toBe("1");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("content-type")).toBe("text/javascript");
  });

  it("serves the original bytes when a transform throws or returns null", async () => {
    const throwing = wrapProtocolHandler(appHandler(), deps({ transform: () => { throw new Error("boom"); } }));
    expect(await (await throwing(req("/assets/index-abc.js"))).text()).toBe("console.log('hello');");
    const none = wrapProtocolHandler(appHandler(), deps({ transform: () => null }));
    expect(await (await none(req("/assets/index-abc.js"))).text()).toBe("console.log('hello');");
  });

  it("serves the original when the patch decision throws", async () => {
    const h = wrapProtocolHandler(appHandler(), deps({ hasPatchesFor: () => { throw new Error("index broke"); } }));
    expect(await (await h(req("/assets/index-abc.js"))).text()).toBe("console.log('hello');");
  });

  it("waits for plugin activation before the first chunk decision", async () => {
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    const has = vi.fn(() => true);
    const pending = wrapProtocolHandler(appHandler(), deps({ ready, hasPatchesFor: has }))(req("/assets/index-abc.js"));
    await new Promise((r) => setTimeout(r, 10));
    expect(has).not.toHaveBeenCalled();
    release();
    expect(await (await pending).text()).toBe("console.log('patched');");
  });

  it("answers /__t3p/ before the app handler and leaves other hosts and methods alone", async () => {
    const app = vi.fn(appHandler());
    const h = wrapProtocolHandler(app, deps());
    expect(await (await h(req("/__t3p/renderer.js"))).text()).toBe("virtual");
    expect(app).not.toHaveBeenCalled();
    const post = await h(req("/assets/index-abc.js", { method: "POST", body: "x" }));
    expect(await post.text()).toBe("console.log('hello');");
    const head = await h(req("/assets/index-abc.js", { method: "HEAD" }));
    expect(head.status).toBe(200);
  });

  it("passes 404s through", async () => {
    expect((await wrapProtocolHandler(appHandler(), deps())(req("/assets/missing.js"))).status).toBe(404);
  });

  it("injectRendererScript is idempotent and has fallbacks", () => {
    const once = injectRendererScript(HTML);
    expect(injectRendererScript(once)).toBe(once);
    expect(injectRendererScript("<html><head></head></html>")).toContain(`${RENDERER_SCRIPT_URL}"></script>\n</head>`);
    expect(injectRendererScript("plain").startsWith("<script")).toBe(true);
  });

  it("installProtocolWrap wraps only the target scheme", async () => {
    const registered: Record<string, (r: Request) => Response | Promise<Response>> = {};
    const protocol = { handle: (s: string, h: (r: Request) => Response | Promise<Response>) => void (registered[s] = h) };
    installProtocolWrap(protocol, "t3code", deps());
    const other = async (): Promise<Response> => new Response("x");
    protocol.handle("other", other);
    protocol.handle("t3code", appHandler());
    expect(registered.other).toBe(other);
    expect(await (await registered.t3code!(req("/assets/index-abc.js"))).text()).toBe("console.log('patched');");
  });
});

describe("virtual routes", () => {
  let base: string;
  let runtimeDir: string;
  let pluginDir: string;
  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "t3p-virtual-")));
    runtimeDir = join(base, "runtime");
    pluginDir = join(base, "plugins", "good");
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(join(pluginDir, "dist"), { recursive: true });
    writeFileSync(join(runtimeDir, "renderer.js"), "/*renderer*/");
    writeFileSync(join(pluginDir, "dist", "r.js"), "export const x = 1;");
    writeFileSync(join(pluginDir, "plugin.json"), "{}");
    writeFileSync(join(base, "plugins", "secret.js"), "secret");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const platform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);
  const vdeps = { runtimeDir: "", pluginDir: (id: string) => (id === "good" ? pluginDir : null), platform, log: nullLogger };
  const get = (path: string, method = "GET"): Response => serveVirtual(new URL(`t3code://app${path}`), method, { ...vdeps, runtimeDir });

  it("serves renderer.js and plugin files with safe headers", async () => {
    const r = get("/__t3p/renderer.js");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("/*renderer*/");
    const p = get("/__t3p/plugins/good/dist/r.js");
    expect(p.status).toBe(200);
    expect(p.headers.get("content-type")).toContain("javascript");
    expect(p.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    "/__t3p/plugins/good/../secret.js",
    "/__t3p/plugins/good/%2e%2e/secret.js",
    "/__t3p/plugins/good/..%2fsecret.js",
    "/__t3p/plugins/good/..%5csecret.js",
    "/__t3p/plugins/good/dist%2f..%2f..%2fsecret.js",
    "/__t3p/plugins/good/plugin.json:stream",
    "/__t3p/plugins/good/dist/r.js.",
    "/__t3p/plugins/good/nul.js",
    "/__t3p/plugins/good/dist/r.exe",
    "/__t3p/plugins/disabled/r.js",
    "/__t3p/plugins/..%2fplugins/secret.js",
    "/__t3p/plugins/Good/dist/r.js",
    "/__t3p/other",
  ])("404s %s", (path) => {
    expect(get(path).status).toBe(404);
  });

  it("rejects non-GET methods", () => {
    expect(get("/__t3p/renderer.js", "POST").status).toBe(405);
  });
});
