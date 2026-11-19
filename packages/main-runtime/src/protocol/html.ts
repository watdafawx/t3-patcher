export const RENDERER_SCRIPT_URL = "t3code://app/__t3p/renderer.js";

/**
 * Inserts the renderer bootstrap as a classic (blocking) script right before
 * the first <script> of index.html, so it runs before the app's module
 * scripts. Idempotent. Falls back to before </head>, then to the start.
 */
export function injectRendererScript(html: string, src: string = RENDERER_SCRIPT_URL): string {
  if (html.includes(src)) return html;
  const tag = `<script src="${src}"></script>`;
  const firstScript = html.search(/<script\b/i);
  if (firstScript >= 0) return `${html.slice(0, firstScript)}${tag}\n    ${html.slice(firstScript)}`;
  const headEnd = html.search(/<\/head>/i);
  if (headEnd >= 0) return `${html.slice(0, headEnd)}${tag}\n${html.slice(headEnd)}`;
  return `${tag}\n${html}`;
}
