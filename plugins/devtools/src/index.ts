import type { PluginModule, T3Api } from "@t3p/api";

import { createLiveChunkLoader, type ChunkLoader } from "./ui/live-chunks.js";
import { LogTailer } from "./ui/log-tailer.js";
import { mountLogsTab } from "./ui/logs-tab.js";
import { OutlineController } from "./ui/outline-controller.js";
import { mountPatchTab } from "./ui/patch-tab.js";
import { mountRpcTab } from "./ui/rpc-tab.js";
import { mountSlotsTab } from "./ui/slots-tab.js";

/**
 * Developer tools. Read-only where it can be: the patch tester never registers a
 * patch, and nothing here evaluates app code. The RPC console is the dangerous
 * part (full-scope bearer), hence the visible warning and the confirm step.
 */
const plugin: PluginModule = {
  start(t3: T3Api) {
    const outlines = new OutlineController(t3);
    const tailer = new LogTailer(t3);

    const loadChunks: ChunkLoader = (onProgress) =>
      createLiveChunkLoader({
        doc: document,
        performanceEntries: performance.getEntriesByType("resource"),
        baseUrl: location.href,
        fetch: (input, init) => fetch(input, init),
      })(onProgress);

    const registrations = [
      t3.ui.register({
        slot: "rightPanel",
        id: "patch-tester",
        title: "Patches",
        order: 20,
        render(host, ctx) {
          const tab = mountPatchTab(host, {
            api: t3,
            loadChunks,
            onThemeChange: (callback) => ctx.onThemeChange(callback),
          });
          return () => tab.dispose();
        },
      }),
      t3.ui.register({
        slot: "rightPanel",
        id: "rpc-console",
        title: "RPC",
        order: 21,
        render(host, ctx) {
          const tab = mountRpcTab(host, { api: t3, onThemeChange: (callback) => ctx.onThemeChange(callback) });
          return () => tab.dispose();
        },
      }),
      t3.ui.register({
        slot: "rightPanel",
        id: "slot-outlines",
        title: "Slots",
        order: 22,
        render(host, ctx) {
          const tab = mountSlotsTab(host, { api: t3, outlines, onThemeChange: (callback) => ctx.onThemeChange(callback) });
          return () => tab.dispose();
        },
      }),
      t3.ui.register({
        slot: "rightPanel",
        id: "plugin-logs",
        title: "Logs",
        order: 23,
        render(host, ctx) {
          const tab = mountLogsTab(host, {
            api: t3,
            tailer,
            pluginId: t3.id,
            onThemeChange: (callback) => ctx.onThemeChange(callback),
          });
          return () => tab.dispose();
        },
      }),
    ];

    const commands = [
      t3.commands.register({
        id: "toggle-outlines",
        title: "Devtools: toggle slot outlines",
        description: "Outline plugin roots and slot anchors",
        keywords: ["devtools", "outline", "slot"],
        run: () => {
          const on = outlines.toggle();
          t3.ui.toast({ title: "Devtools", message: on ? "Slot outlines on" : "Slot outlines off", kind: "info", durationMs: 2000 });
        },
      }),
      t3.commands.register({
        id: "refresh-logs",
        title: "Devtools: refresh plugin logs",
        description: "Read new plugin lines from main.log",
        keywords: ["devtools", "log", "tail"],
        run: async () => {
          const added = await tailer.poll();
          t3.ui.toast({ title: "Devtools", message: `${added} new plugin log line(s)`, kind: "info", durationMs: 2000 });
        },
      }),
    ];

    t3.log("info", `devtools started (read-only patch tester, RPC console, outlines, logs; t3 API ${t3.apiVersion})`);

    return () => {
      for (const registration of registrations) registration.dispose();
      for (const command of commands) command.dispose();
      outlines.dispose();
      tailer.dispose();
    };
  },
};

export default plugin;
