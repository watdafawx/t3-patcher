/**
 * Custom CSS safety: scopes every rule under a plugin-owned root selector and rejects anything that could
 * leave it (imports, remote urls unless allowed, escapes, `!important`, risky functions).
 * Pure text in, text out: no DOM, so it is easy to test.
 */

export const MAX_CSS = 40_000;

export interface ScopeOptions {
  /** Selector of the plugin-owned root, e.g. `[data-t3p-custom="header"]`. */
  scope: string;
  /** Prefix for `@keyframes` names so they cannot collide with the app's. */
  prefix: string;
  allowRemote: boolean;
}

export interface ScopeResult {
  css: string;
  errors: string[];
  warnings: string[];
}

const line = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Removes comments (keeping newlines so line numbers stay right) and rejects escapes outside strings. */
function clean(css: string): { text: string; error?: string } {
  let out = "";
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]!;
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) {
        if (css[j] === "\n") return { text: out, error: `line ${line(css, i)}: unterminated string` };
        j += css[j] === "\\" ? 2 : 1;
      }
      if (j >= css.length) return { text: out, error: `line ${line(css, i)}: unterminated string` };
      out += css.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "\\") return { text: out, error: `line ${line(css, i)}: CSS escapes (\\) are only allowed inside strings` };
    out += ch;
  }
  return { text: out };
}

/** Index of `stop` (one of the given chars) at paren/bracket depth 0 outside strings, or -1. */
function findTop(text: string, from: number, stops: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && stops.includes(ch)) return i;
  }
  return -1;
}

/** Index of the `}` that closes the `{` at `open`, or -1. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      i += 1;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function splitCommas(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = findTop(text, from, ",");
    if (at < 0) break;
    parts.push(text.slice(from, at));
    from = at + 1;
  }
  parts.push(text.slice(from));
  return parts;
}

const BAD_AT = /@(import|namespace|charset|font-face|property|font-feature-values|counter-style|page|scope|document|view-transition|starting-style)\b/i;
const BAD_FN = /(^|[^\w-])(?:-webkit-)?(image-set|src|cross-fade|element|paint|image)\s*\(/i;
const BAD_MISC = /expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:|vbscript\s*:/i;
const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;

/** Errors for one chunk of declarations (or a keyframes body). */
export function checkDeclarations(body: string, allowRemote: boolean): string[] {
  const errors: string[] = [];
  const text = body.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/!\s*important/i.test(text)) errors.push("!important is not allowed (it could override the plugin's safety rules)");
  if (BAD_AT.test(text)) errors.push(`${(BAD_AT.exec(text) as RegExpExecArray)[0]} is not allowed`);
  if (BAD_FN.test(text)) errors.push(`${(BAD_FN.exec(text) as RegExpExecArray)[2]}() is not allowed (use url() with a data:image or #fragment)`);
  if (BAD_MISC.test(text)) errors.push("script-like values (expression, behavior, javascript:) are not allowed");
  for (const m of text.matchAll(URL_RE)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml)[;,]/i.test(value) || value.startsWith("#")) continue;
    if (/^(https?:)?\/\//i.test(value)) {
      if (!allowRemote) errors.push(`remote url "${value.slice(0, 48)}" is blocked (turn on "Allow remote assets" to use it)`);
      continue;
    }
    errors.push(`url("${value.slice(0, 48)}") is not allowed: only data:image and #fragment urls${allowRemote ? " and http(s) urls" : ""}`);
  }
  return errors;
}

function scopeSelector(selector: string, scope: string): string {
  const sel = selector.trim();
  const root = /^(?::root|html|body|:host)(?![\w-])/i.exec(sel);
  return root ? scope + sel.slice(root[0].length) : `${scope} ${sel}`;
}

const BLOCK_AT = new Set(["media", "supports", "container", "layer"]);

/** Scopes `css` under `options.scope`. `errors` non-empty means "do not apply". */
export function scopeCss(css: string, options: ScopeOptions): ScopeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = (out: string): ScopeResult => ({ css: errors.length ? "" : out, errors, warnings });
  if (css.length > MAX_CSS) return { css: "", errors: [`CSS is ${css.length} characters, the limit is ${MAX_CSS}`], warnings };
  const cleaned = clean(css);
  if (cleaned.error) return { css: "", errors: [cleaned.error], warnings };
  const text = cleaned.text;
  const names = new Map<string, string>();

  const walk = (src: string, base: number): string => {
    let out = "";
    let i = 0;
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i += 1;
      if (i >= src.length) return out;
      const at = (): number => line(text, base + i);
      const stop = findTop(src, i, "{};");
      if (stop < 0) {
        errors.push(`line ${at()}: unexpected end (missing "{" or ";")`);
        return out;
      }
      const prelude = src.slice(i, stop).trim();
      if (src[stop] === "}") {
        errors.push(`line ${at()}: unexpected "}"`);
        return out;
      }
      if (src[stop] === ";") {
        if (/^@layer\s+[\w\s.,-]+$/i.test(prelude)) out += `${prelude};`;
        else errors.push(prelude.startsWith("@") ? `line ${at()}: ${prelude.split(/\s/)[0]} is not allowed` : `line ${at()}: declarations need a selector (use :root for the container itself)`);
        i = stop + 1;
        continue;
      }
      const close = matchBrace(src, stop);
      if (close < 0) {
        errors.push(`line ${at()}: missing "}"`);
        return out;
      }
      const body = src.slice(stop + 1, close);
      const where = at();
      if (prelude.startsWith("@")) {
        const name = (/^@(?:-webkit-)?([\w-]+)/.exec(prelude)?.[1] ?? "").toLowerCase();
        if (BLOCK_AT.has(name)) out += `${prelude}{${walk(body, base + stop + 1)}}`;
        else if (name === "keyframes") {
          const raw = prelude.replace(/^@(?:-webkit-)?keyframes\s*/i, "");
          if (!/^[\w-]+$/.test(raw)) errors.push(`line ${where}: bad @keyframes name`);
          else {
            const mapped = `${options.prefix}${raw}`;
            names.set(raw, mapped);
            errors.push(...checkDeclarations(body, options.allowRemote).map((e) => `line ${where}: ${e}`));
            out += `@keyframes ${mapped}{${body}}`;
          }
        } else errors.push(`line ${where}: @${name} is not allowed`);
      } else {
        const selectors = splitCommas(prelude).map((s) => s.trim());
        if (selectors.some((s) => s === "")) errors.push(`line ${where}: empty selector`);
        else {
          errors.push(...checkDeclarations(body, options.allowRemote).map((e) => `line ${where}: ${e}`));
          out += `${selectors.map((s) => scopeSelector(s, options.scope)).join(",")}{${body}}`;
        }
      }
      i = close + 1;
    }
  };

  let out = walk(text, 0);
  if (names.size > 0) {
    out = out.replace(/(animation(?:-name)?\s*:)([^;}]*)/gi, (_m, head: string, value: string) => {
      let v = value;
      for (const [from, to] of names) v = v.replace(new RegExp(`(?<![\\w-])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"), to);
      return head + v;
    });
  }
  const colors = text.replace(URL_RE, "").replace(/"[^"]*"|'[^']*'/g, "");
  if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb)\(/i.test(colors)) warnings.push("hard-coded color found: prefer app variables like var(--primary) so every theme works");
  return result(out);
}
