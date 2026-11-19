import { checkDeclarations } from "./custom-css.js";

/**
 * Custom HTML sanitizer. Parses with `DOMParser` (scripts stay inert), removes dangerous elements and
 * attributes in place, and hands back the cleaned `<body>`. Callers import its child nodes instead of
 * re-parsing a string, so there is no serialize/parse round trip to abuse.
 */

export const MAX_HTML = 20_000;

/** Elements removed with everything inside them. */
const DROP = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "form", "input", "button", "textarea", "select", "option",
  "style", "template", "noscript", "applet", "canvas", "audio", "video", "source", "track", "foreignobject", "animate", "set", "title", "head",
  "portal", "dialog", "slot", "math", "param", "svg:script",
]);

/** Attributes that never survive, besides every `on*` and `data-*`. */
const DROP_ATTR = new Set(["srcset", "ping", "action", "formaction", "poster", "manifest", "data", "background", "cite", "longdesc", "usemap", "name", "is", "slot", "srcdoc", "form", "autofocus", "contenteditable", "tabindex", "accesskey", "draggable", "nonce"]);

const IMAGE_DATA = /^data:image\/(png|jpe?g|webp|gif|svg\+xml)[;,]/i;

export interface HtmlOptions {
  allowRemote: boolean;
}

export interface HtmlResult {
  /** Cleaned `<body>` (belongs to a throwaway document). */
  body: HTMLElement;
  /** Cleaned markup, for size and display only. */
  html: string;
  errors: string[];
  /** Plain-language list of what was removed. */
  removed: string[];
}

function urlAllowed(value: string, attr: string, tag: string, allowRemote: boolean): boolean {
  const v = value.trim();
  if (v.startsWith("#") && (attr === "href" || attr === "xlink:href")) return true;
  const image = attr === "src" || (tag === "image" && (attr === "href" || attr === "xlink:href"));
  if (!image) return false;
  if (IMAGE_DATA.test(v)) return true;
  return allowRemote && /^(https?:)?\/\//i.test(v);
}

export function sanitizeHtml(source: string, options: HtmlOptions): HtmlResult {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${source.length > MAX_HTML ? "" : source}`, "text/html");
  const body = doc.body;
  const removed = new Set<string>();
  const errors: string[] = [];
  if (source.length > MAX_HTML) errors.push(`HTML is ${source.length} characters, the limit is ${MAX_HTML}`);

  const clean = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.localName.toLowerCase();
      if (DROP.has(tag)) {
        removed.add(`<${tag}>`);
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        let bad = name.startsWith("on") || name.startsWith("data-") || DROP_ATTR.has(name);
        if (!bad && (name === "href" || name === "src" || name === "xlink:href")) bad = !urlAllowed(attr.value, name, tag, options.allowRemote);
        if (!bad && name === "style") bad = checkDeclarations(attr.value, options.allowRemote).length > 0;
        if (bad) {
          removed.add(`${name}${name.startsWith("on") ? "" : ` on <${tag}>`}`);
          child.removeAttribute(attr.name);
        }
      }
      clean(child);
    }
  };
  if (errors.length === 0) clean(body);
  return { body, html: body.innerHTML, errors, removed: [...removed] };
}
