import type { PluginModule, SettingSchema, T3Api } from "@t3p/api";

/** Settings this plugin shows on the Plugins settings page. */
const settings: SettingSchema[] = [
  {
    key: "greeting",
    type: "string",
    default: "hello",
    label: "Greeting",
    description: "Logged when the plugin starts.",
  },
];

const plugin: PluginModule = {
  start(t3: T3Api) {
    const schemas = t3.settings.define(settings);
    const unsubscribe = t3.settings.onChange(({ key, value }) => {
      t3.log("info", `setting ${key} is now ${String(value)}`);
    });

    t3.log(
      "info",
      `${t3.plugin.id} started: "${t3.settings.get<string>("greeting")}" (t3 API ${t3.apiVersion}, tier ${t3.plugin.tier})`,
    );

    return () => {
      unsubscribe();
      schemas.dispose();
    };
  },

  stop() {
    // Everything registered through `t3` is disposed by the runtime already;
    // use this hook for your own timers, sockets and event handlers.
  },
};

export default plugin;
