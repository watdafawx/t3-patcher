import type { PluginModule, T3Api } from "@t3p/api";
import { mountInspector } from "./ui/panel.js";

const plugin: PluginModule = {
  start(t3: T3Api) {
    const reg = t3.ui.register({
      slot: "rightPanel",
      id: "inspector",
      title: "Inspector",
      order: 10,
      render(host, ctx) {
        const inspector = mountInspector(host, {
          api: t3,
          onThemeChange: (cb) => ctx.onThemeChange(cb),
        });
        return () => inspector.dispose();
      },
    });
    t3.log("info", "session-inspector started");
    return () => reg.dispose();
  },
};

export default plugin;
