// WP-2 test plugin (renderer entry, ES module served from t3code://app/__t3p/plugins/test-plugin/renderer.js).
export const loadedAt = performance.now();

export async function start(ctx) {
  window.__t3p_test_plugin = { started: true, id: ctx.id };
  ctx.log("info", "test-plugin renderer started");
}
