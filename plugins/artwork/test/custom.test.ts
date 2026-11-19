// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { scopeCss } from "../src/custom-css.js";
import { sanitizeHtml } from "../src/custom-html.js";
import { CustomLayers, parseBundle, emptyBundle } from "../src/custom.js";
import { backgroundTemplate, headerTemplate } from "../src/custom-templates.js";
import type { ArtworkConfig } from "../src/model.js";

const SCOPE = '[data-t3p-custom="header"]';
const scope = (css: string, allowRemote = false) => scopeCss(css, { scope: SCOPE, prefix: "t3pc-header-", allowRemote });
const clean = (html: string, allowRemote = false) => sanitizeHtml(html, { allowRemote });

describe("sanitizeHtml", () => {
  it("keeps plain static markup, svg and data images", () => {
    const r = clean('<div class="a"><span>hi</span><svg viewBox="0 0 4 4"><circle cx="2" cy="2" r="1"/></svg><img src="data:image/png;base64,AAAA" alt=""></div>');
    expect(r.errors).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.html).toContain("<svg");
    expect(r.html).toContain('src="data:image/png;base64,AAAA"');
  });

  it.each(["script", "iframe", "object", "embed", "link", "meta", "base", "form", "style", "canvas", "video"])("drops <%s> with its content", (tag) => {
    const r = clean(`<p>ok</p><${tag} src="x" href="y">${["embed", "link", "meta", "base"].includes(tag) ? "" : "boom"}</${tag}>`);
    expect(r.html).toBe("<p>ok</p>");
    expect(r.removed).toContain(`<${tag}>`);
  });

  it("strips on* handlers and data-* attributes", () => {
    const r = clean('<div onclick="x()" onmouseover="y()" data-slot="sidebar" class="k">a</div>');
    expect(r.html).toBe('<div class="k">a</div>');
    expect(r.removed).toContain("onclick");
  });

  it("strips javascript: and data:text/html urls, including whitespace tricks", () => {
    const r = clean(
      '<a href="javascript:alert(1)">a</a><a href="  JaVa\tScRiPt:alert(1)">b</a><img src="data:text/html;base64,PHNjcmlwdD4=" alt=""><img src="javascript:1" alt=""><svg><use href="data:text/html,x"/></svg>',
    );
    expect(r.html).not.toMatch(/javascript|data:text/i);
    expect(r.html).not.toMatch(/\shref=|\ssrc=/);
  });

  it("only allows #fragment links and svg use", () => {
    const r = clean('<a href="#x">a</a><a href="https://evil.test">b</a><svg><use href="#g"/></svg>');
    expect(r.html).toContain('href="#x"');
    expect(r.html).toContain('href="#g"');
    expect(r.html).not.toContain("evil.test");
  });

  it("blocks remote images unless allowed", () => {
    const html = '<img src="https://example.test/a.png" alt="">';
    expect(clean(html).html).not.toContain("example.test");
    expect(clean(html, true).html).toContain("https://example.test/a.png");
  });

  it("filters inline style with the CSS rules", () => {
    expect(clean('<div style="opacity:.5">a</div>').html).toContain('style="opacity:.5"');
    expect(clean('<div style="background:url(https://e.test/a.png)">a</div>').html).not.toContain("style=");
    expect(clean('<div style="width:1px!important">a</div>').html).not.toContain("style=");
  });

  it("drops svg animate/set (href takeover vector) and srcset/name/tabindex", () => {
    const r = clean('<svg><a href="#a"><animate attributeName="href" values="javascript:x"/><set attributeName="href" to="javascript:x"/></a></svg><img srcset="a 1x" name="x" tabindex="0" alt="">');
    expect(r.html).not.toMatch(/animate|<set|javascript|srcset|name=|tabindex/);
  });

  it("rejects oversized html with an error", () => {
    const r = clean("a".repeat(20_001));
    expect(r.errors[0]).toContain("HTML is 20001");
  });

  it("mXSS shapes stay inert (nested noscript/style/svg)", () => {
    const r = clean('<svg><style><img src=x onerror=alert(1)></style></svg><noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>');
    expect(r.html).not.toMatch(/onerror/);
  });
});

describe("scopeCss", () => {
  it("prefixes every selector, maps :root/html/body to the container", () => {
    const r = scope(":root{opacity:.5} html .a, body, .b > i{color:var(--primary)}\n.c:hover::before{content:'x'}");
    expect(r.errors).toEqual([]);
    expect(r.css).toBe(`${SCOPE}{opacity:.5}${SCOPE} .a,${SCOPE},${SCOPE} .b > i{color:var(--primary)}${SCOPE} .c:hover::before{content:'x'}`);
  });

  it("scopes rules inside @media, @supports and @container", () => {
    const r = scope("@media (min-width:600px){.a{top:0}} @supports (display:grid){.b{left:0}}");
    expect(r.css).toBe(`@media (min-width:600px){${SCOPE} .a{top:0}}@supports (display:grid){${SCOPE} .b{left:0}}`);
  });

  it("renames @keyframes and the animation references to them", () => {
    const r = scope("@keyframes spin{0%{opacity:0}100%{opacity:1}} .a{animation:spin 2s linear infinite} .b{animation-name:spin}");
    expect(r.errors).toEqual([]);
    expect(r.css).toContain("@keyframes t3pc-header-spin{");
    expect(r.css).toContain("animation:t3pc-header-spin 2s linear infinite");
    expect(r.css).toContain("animation-name:t3pc-header-spin");
  });

  it.each([
    ["@import url(a.css);", "@import"],
    ["@import 'a.css';", "@import"],
    [".a{background:url(https://evil.test/x.png)}", "remote url"],
    [".a{background:url(//evil.test/x.png)}", "remote url"],
    [".a{background:url('http://evil.test/x.png')}", "remote url"],
    [".a{background:url(javascript:alert(1))}", "not allowed"],
    [".a{background:url(file:///c:/x.png)}", "not allowed"],
    [".a{background:url(local.png)}", "not allowed"],
    [".a{color:red!important}", "!important"],
    [".a{width:expression(alert(1))}", "script-like"],
    [".a{background:image-set('https://e.test/a.png' 1x)}", "image-set"],
    [".a{b\\61ckground:url(x)}", "escapes"],
    ["@font-face{font-family:x;src:url(a.woff)}", "@font-face"],
    ["@namespace svg url(x);", "@namespace"],
    ["color:red;", "declarations need a selector"],
    [".a{color:red", 'missing "}"'],
    ["}", 'unexpected "}"'],
    [".a{color:'x}", "unterminated string"],
    [".a{top:0}} .b{top:0}", 'unexpected "}"'],
  ])("rejects %s", (css, message) => {
    const r = scope(css);
    expect(r.errors.join("\n")).toContain(message);
    expect(r.css).toBe("");
  });

  it("allows data:image and #fragment urls, remote only with allowRemote", () => {
    expect(scope(".a{background:url(data:image/png;base64,AAAA)} .b{fill:url(#g)}").errors).toEqual([]);
    const remote = ".a{background:url(https://cdn.test/a.png)}";
    expect(scope(remote).errors.length).toBe(1);
    expect(scope(remote, true).errors).toEqual([]);
  });

  it("cannot be tricked by comments, nested braces or string braces", () => {
    const r = scope('/* } .x{top:0} */ .a{content:"}{";top:0} .b{ &:hover{top:1} }');
    expect(r.errors).toEqual([]);
    expect(r.css).toBe(`${SCOPE} .a{content:"}{";top:0}${SCOPE} .b{ &:hover{top:1} }`);
  });

  it("reports the line of the problem", () => {
    expect(scope(".a{top:0}\n\n.b{color:red!important}").errors[0]).toMatch(/^line 3:/);
  });

  it("warns about hard-coded colors but still applies", () => {
    const r = scope(".a{color:#fff}");
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toContain("hard-coded color");
    expect(scope(".a{fill:url(#fff)}").warnings).toEqual([]);
  });

  it("rejects css over the size limit", () => {
    expect(scope(".a{top:0}".repeat(6000)).errors[0]).toContain("limit");
  });
});

describe("generated templates pass our own safety rules", () => {
  const base: ArtworkConfig = { preset: "aurora", intensity: 60, speed: 40, hue: -1, fadeHeight: 190, blur: 24, angle: 160 };
  it.each(["aurora", "gradient", "mesh", "image", "none"] as const)("header %s", (preset) => {
    const t = headerTemplate({ ...base, preset });
    const css = scope(t.css);
    expect(css.errors).toEqual([]);
    expect(css.warnings).toEqual([]);
    expect(clean(t.html).removed).toEqual([]);
    expect(clean(t.html).html).toBe(t.html);
  });
  it("header with a fixed hue and speed 0 has no animation", () => {
    const t = headerTemplate({ ...base, hue: 200, speed: 0 });
    expect(t.css).not.toContain("animation");
    expect(scope(t.css).errors).toEqual([]);
  });
  it("background", () => {
    const t = backgroundTemplate(base);
    expect(scopeCss(t.css, { scope: '[data-t3p-custom="background"]', prefix: "t3pc-background-", allowRemote: false }).errors).toEqual([]);
    expect(t.html).toContain("blobs");
  });
});

describe("parseBundle", () => {
  it("round trips and fills missing targets", () => {
    const b = parseBundle(JSON.stringify({ v: 1, header: { enabled: true, html: "<i></i>", css: "i{top:0}" } }));
    expect(b.bundle?.header).toEqual({ enabled: true, html: "<i></i>", css: "i{top:0}" });
    expect(b.bundle?.background).toEqual({ enabled: false, html: "", css: "" });
  });
  it.each(["{", "[]", "null", '{"v":2}', '{"v":1,"header":{"html":3}}', '{"v":1,"header":"x"}', `{"v":1,"background":{"css":"${"a".repeat(40_001)}"}}`])("rejects %s", (text) => {
    const r = parseBundle(text);
    expect(r.bundle).toBeUndefined();
    expect(r.error).toBeTruthy();
  });
});

describe("CustomLayers apply and dispose", () => {
  let layers: CustomLayers | undefined;
  afterEach(() => {
    layers?.dispose();
    layers = undefined;
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    document.documentElement.removeAttribute("data-t3p-cbg");
    vi.useRealTimers();
  });
  const make = (allowRemote = false) => (layers = new CustomLayers({ allowRemote: () => allowRemote }));
  const host = (): HTMLElement => {
    const h = document.createElement("div");
    document.body.appendChild(h);
    return h;
  };

  it("does nothing until enabled", () => {
    const c = make();
    const h = host();
    c.ensure(h);
    c.update("header", { html: "<b>x</b>", css: ".a{top:0}" });
    expect(h.querySelector("[data-t3p-custom]")).toBeNull();
    expect(c.active("header")).toBe(false);
    expect(document.getElementById("t3p-art-custom-style")).toBeNull();
  });

  it("mounts the header root in the host with scoped style and sanitized html", () => {
    const c = make();
    const h = host();
    c.ensure(h);
    const v = c.update("header", { enabled: true, html: '<b class="a" onclick="x()">x</b><script>1</script>', css: ".a{top:0}" });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join()).toContain("<script>");
    const root = h.querySelector('[data-t3p-custom="header"]') as HTMLElement;
    expect(root.firstElementChild!.tagName).toBe("STYLE");
    expect(root.querySelector("style")!.textContent).toBe('[data-t3p-custom="header"] .a{top:0}');
    expect(root.querySelector("b")!.outerHTML).toBe('<b class="a">x</b>');
    expect(root.querySelector("script")).toBeNull();
    expect(c.active("header")).toBe(true);
    expect(document.getElementById("t3p-art-custom-style")!.textContent).toContain("pointer-events:none!important");
  });

  it("keeps the last good version when new input is broken, and reports why", () => {
    const c = make();
    const h = host();
    c.ensure(h);
    c.update("header", { enabled: true, html: "<b>ok</b>", css: ".a{top:0}" });
    const v = c.update("header", { css: ".a{top:0} @import 'x';" });
    expect(v.errors.length).toBeGreaterThan(0);
    expect(c.active("header")).toBe(true);
    expect(h.querySelector("style[data-x], [data-t3p-custom] style")!.textContent).toBe('[data-t3p-custom="header"] .a{top:0}');
  });

  it("broken input never applies when nothing good was applied", () => {
    const c = make();
    const h = host();
    c.ensure(h);
    c.update("header", { enabled: true, html: "<b>ok</b>", css: "}" });
    expect(c.active("header")).toBe(false);
    expect(h.querySelector("[data-t3p-custom]")).toBeNull();
  });

  it("background root goes first in <body> and makes surfaces see-through, then cleans up", () => {
    vi.useFakeTimers();
    const c = make();
    const h = host();
    c.ensure(h);
    c.update("background", { enabled: true, html: "<i></i>", css: "i{top:0}" });
    const root = document.body.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-t3p-custom")).toBe("background");
    expect(document.documentElement.hasAttribute("data-t3p-cbg")).toBe(true);
    c.update("background", { enabled: false });
    expect(document.querySelector("[data-t3p-custom]")).toBeNull();
    expect(document.documentElement.hasAttribute("data-t3p-cbg")).toBe(false);
    expect(document.getElementById("t3p-art-custom-style")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turning a target off removes its node only", () => {
    const c = make();
    const h = host();
    c.ensure(h);
    c.update("header", { enabled: true, html: "<b>1</b>" });
    c.update("background", { enabled: true, html: "<b>2</b>" });
    c.update("header", { enabled: false });
    expect(document.querySelector('[data-t3p-custom="header"]')).toBeNull();
    expect(document.querySelector('[data-t3p-custom="background"]')).not.toBeNull();
    expect(c.active("header")).toBe(false);
    expect(c.active("background")).toBe(true);
  });

  it("dispose removes every injected node, style, attribute and timer", () => {
    vi.useFakeTimers();
    const c = make();
    const h = host();
    c.ensure(h);
    c.update("header", { enabled: true, html: "<b>1</b>" });
    c.update("background", { enabled: true, html: "<b>2</b>" });
    c.dispose();
    expect(document.querySelector("[data-t3p-custom]")).toBeNull();
    expect(document.getElementById("t3p-art-custom-style")).toBeNull();
    expect(document.documentElement.hasAttribute("data-t3p-cbg")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    c.ensure(h); // late mutation observer call after stop must not bring anything back
    expect(document.querySelector("[data-t3p-custom]")).toBeNull();
  });

  it("re-attaches a root React dropped, and waits for the sidebar to exist", () => {
    const c = make();
    c.update("header", { enabled: true, html: "<b>1</b>" });
    expect(document.querySelector("[data-t3p-custom]")).toBeNull();
    const h = host();
    c.ensure(h);
    expect(h.querySelector("[data-t3p-custom]")).not.toBeNull();
    h.innerHTML = "";
    c.ensure(h);
    expect(h.querySelector("[data-t3p-custom]")).not.toBeNull();
  });

  it("revalidate follows the allowRemote setting", () => {
    let allow = false;
    layers = new CustomLayers({ allowRemote: () => allow });
    const c = layers;
    c.ensure(host());
    c.update("header", { enabled: true, html: "", css: ".a{background:url(https://e.test/a.png)}" });
    expect(c.active("header")).toBe(false);
    expect(c.view("header").errors[0]).toContain("remote url");
    allow = true;
    c.revalidate();
    expect(c.active("header")).toBe(true);
    expect(c.view("header").errors).toEqual([]);
  });

  it("emits changes and load() replaces everything", () => {
    const c = make();
    c.ensure(host());
    const fn = vi.fn();
    c.onChange(fn);
    const b = emptyBundle();
    b.header = { enabled: true, html: "<b>1</b>", css: "" };
    c.load(b);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.active("header")).toBe(true);
    expect(c.bundle().header.html).toBe("<b>1</b>");
  });
});
