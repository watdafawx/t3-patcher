// Healthy renderer-only plugin: must load even though throw-main and throw-renderer fail.
export function start(ctx) {
  window.__t3p_after_renderer = { started: true, id: ctx.id };
}
