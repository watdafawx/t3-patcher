import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readState } from "../src/plugin-admin.js";
import { runPluginsCommand, type PluginsCliFlags, UsageError } from "../src/registry-cli.js";
import { entryFor, fakeFetch, indexOf, pluginZip, REGISTRY_URL } from "./registry-helpers.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "t3p-regcli-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const flags = (f: Partial<PluginsCliFlags> = {}): PluginsCliFlags => ({ json: false, yes: false, installed: false, all: false, ...f });

function world(entries = [{ id: "demo", version: "1.0.0" }]) {
  const routes: Record<string, { body: Buffer | string }> = {};
  const list = entries.map((e) => {
    const zip = pluginZip({ id: e.id, version: e.version });
    const entry = entryFor(zip, e);
    routes[entry.download.url] = { body: zip };
    return entry;
  });
  routes[REGISTRY_URL] = { body: JSON.stringify(indexOf(...list)) };
  return { fetch: fakeFetch(routes), entries: list, routes };
}

async function run(argv: string[], f: Partial<PluginsCliFlags>, w: { fetch: ReturnType<typeof fakeFetch> }, answers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const code = await runPluginsCommand(argv, flags(f), {
    homeDir: home,
    env: { T3P_REGISTRY_URL: REGISTRY_URL },
    fetch: w.fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    prompt: async (q) => {
      prompts.push(q);
      return answers.shift() ?? "";
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), prompts };
}

describe("t3p plugins (in-process, injected fetch)", () => {
  it("search and info show registry data and install state", async () => {
    const w = world([
      { id: "demo", version: "1.0.0" },
      { id: "other", version: "2.0.0" },
    ]);
    const s = await run(["search", "other"], {}, w);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/^other\s+2\.0\.0/m);
    expect(s.out).not.toMatch(/^demo/m);
    const all = await run(["list"], {}, w);
    expect(all.out).toMatch(/demo/);
    expect(all.out).toMatch(/other/);
    const none = await run(["search", "zzz"], {}, w);
    expect(none.out).toMatch(/no plugin matches/);
    const info = await run(["info", "demo"], {}, w);
    expect(info.out).toMatch(/author:\s+Tests/);
    expect(info.out).toMatch(/sha256:\s+[0-9a-f]{64}/);
    expect(info.out).toMatch(/- rpc/);
    const json = await run(["info", "demo"], { json: true }, w);
    expect(JSON.parse(json.out)).toMatchObject({ id: "demo", installed: null });
    await expect(run(["info", "nope"], {}, w)).rejects.toThrow(/not in the registry/);
  });

  it("install prints permissions and the warning, needs y, installs disabled with no grants", async () => {
    const w = world();
    const cancelled = await run(["install", "demo"], {}, w, ["n"]);
    expect(cancelled.code).toBe(1);
    expect(cancelled.out).toMatch(/This runs code on your PC with your user rights/);
    expect(cancelled.out).toMatch(/- rpc/);
    expect(cancelled.prompts[0]).toMatch(/Type y to continue/);
    expect(existsSync(join(home, ".t3-patcher", "plugins", "demo"))).toBe(false);

    const ok = await run(["install", "demo"], {}, w, ["y"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/installed demo 1\.0\.0 \(sha256 verified\).*disabled, no permissions granted/);
    expect(readState(home).plugins.demo).toMatchObject({ enabled: false, granted: [] });

    const listed = await run(["search", "demo"], {}, w);
    expect(listed.out).toMatch(/\[installed 1\.0\.0\]/);
  });

  it("--yes skips the prompt; a tampered download is refused", async () => {
    const w = world();
    w.routes[w.entries[0]!.download.url] = { body: pluginZip({ manifest: { description: "evil" } }) };
    await expect(run(["install", "demo"], { yes: true }, w)).rejects.toThrow(/SHA-256 mismatch|bytes, the registry says|larger than/);
    expect(existsSync(join(home, ".t3-patcher", "plugins", "demo"))).toBe(false);
  });

  it("update <id> and --all, keeping grants; uninstall confirms", async () => {
    const w1 = world();
    await run(["install", "demo"], { yes: true }, w1);
    const up0 = await run(["update", "demo"], {}, w1);
    expect(up0.out).toMatch(/up to date/);
    const w2 = world([{ id: "demo", version: "1.2.0" }]);
    const st = readState(home);
    st.plugins.demo!.granted = ["rpc"];
    writeFileSync(join(home, ".t3-patcher", "state.json"), JSON.stringify(st));
    const listed = await run(["list"], {}, w2);
    expect(listed.out).toMatch(/\[update 1\.0\.0 -> 1\.2\.0\]/);
    const up = await run(["update"], { all: true, yes: true }, w2);
    expect(up.code).toBe(0);
    expect(up.out).toMatch(/updated demo 1\.0\.0 -> 1\.2\.0/);
    expect(readState(home).plugins.demo).toMatchObject({ granted: ["rpc"], install: { version: "1.2.0" } });
    expect((await run(["update"], { all: true, yes: true }, w2)).out).toMatch(/all registry plugins are up to date/);

    const no = await run(["uninstall", "demo"], {}, w2, [""]);
    expect(no.code).toBe(1);
    expect(existsSync(join(home, ".t3-patcher", "plugins", "demo"))).toBe(true);
    const yes = await run(["uninstall", "demo"], {}, w2, ["yes"]);
    expect(yes.code).toBe(0);
    expect(existsSync(join(home, ".t3-patcher", "plugins", "demo"))).toBe(false);
    expect(readState(home).plugins.demo).toBeUndefined();
  });

  it("keeps the old listing for plain `plugins` and `list --installed`, and checks usage", async () => {
    const dir = join(home, ".t3-patcher", "plugins", "local");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "local", version: "0.1.0", tier: 1, t3Versions: ["*"], permissions: [], renderer: "r.js" }));
    const w = world();
    const plain = await run([], {}, w);
    expect(plain.out).toMatch(/off\s+local@0\.1\.0/);
    expect(w.fetch.calls).toHaveLength(0);
    const inst = await run(["list"], { installed: true }, w);
    expect(inst.out).toBe(plain.out);
    expect(JSON.parse((await run([], { json: true }, w)).out)[0].id).toBe("local");
    await expect(run(["install"], {}, w)).rejects.toThrow(UsageError);
    await expect(run(["update"], {}, w)).rejects.toThrow(UsageError);
    await expect(run(["update", "demo"], { all: true }, w)).rejects.toThrow(UsageError);
    await expect(run(["frobnicate"], {}, w)).rejects.toThrow(UsageError);
  });
});

describe("t3p plugins (real CLI against a local http registry)", () => {
  const CLI = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  let server: Server;
  let base: string;
  const files = new Map<string, Buffer>();

  beforeEach(async () => {
    server = createServer((req, res) => {
      const body = files.get(req.url ?? "");
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-length": String(body.length) }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const zip = pluginZip();
    const entry = entryFor(zip, { url: `${base}/t3p-plugin-demo-1.0.0.zip` });
    files.set("/t3p-plugin-demo-1.0.0.zip", zip);
    files.set("/index.json", Buffer.from(JSON.stringify(indexOf(entry))));
  });
  afterEach(async () => {
    files.clear();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function cli(args: string[], env: Record<string, string>, input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = execFile(process.execPath, [CLI, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, T3P_HOME: home, ...env } }, (error, stdout, stderr) =>
        resolve({ status: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
      child.stdin?.end(input);
    });
  }

  it("refuses an http registry without the opt-in, installs with it after typing y", async () => {
    const plain = await cli(["plugins", "search", "demo"], { T3P_REGISTRY_URL: `${base}/index.json` });
    expect(plain.status).toBe(1);
    expect(plain.stderr).toMatch(/must be https/);

    const env = { T3P_REGISTRY_URL: `${base}/index.json`, T3P_REGISTRY_ALLOW_INSECURE_LOCAL: "1" };
    const found = await cli(["plugins", "search", "demo"], env);
    expect(found.status).toBe(0);
    expect(found.stdout).toMatch(/^demo\s+1\.0\.0/m);

    const cancelled = await cli(["plugins", "install", "demo"], env, "n\n");
    expect(cancelled.status).toBe(1);
    expect(existsSync(join(home, ".t3-patcher", "plugins", "demo"))).toBe(false);

    const ok = await cli(["plugins", "install", "demo"], env, "y\n");
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/This runs code on your PC with your user rights/);
    expect(readState(home).plugins.demo).toMatchObject({ enabled: false, granted: [] });

    const old = await cli(["plugins"], {});
    expect(old.status).toBe(0);
    expect(old.stdout).toMatch(/off\s+demo@1\.0\.0/);
    expect((await cli(["plugins", "bogus"], env)).status).toBe(2);
  }, 30_000);
});
