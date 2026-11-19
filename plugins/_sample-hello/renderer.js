// WP-3A sample: settings persist, rpc call works. Not published.
export async function start(t3) {
  t3.settings.define([
    { key: "greeting", type: "string", default: "hello", label: "Greeting" },
    { key: "count", type: "number", default: 0, label: "Count", min: 0 },
  ]);
  await t3.settings.set("count", t3.settings.get("count") + 1);
  const state = { starts: t3.settings.get("count"), greeting: t3.settings.get("greeting"), rpc: null, rpcError: null };
  try {
    const cfg = await t3.rpc.call("server.getConfig", {});
    state.rpc = { keys: Object.keys(cfg ?? {}).slice(0, 8) };
  } catch (e) {
    state.rpcError = String(e);
  }
  globalThis.__t3p_sample = state;
}
