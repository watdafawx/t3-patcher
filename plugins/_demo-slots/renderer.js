// WP-3D demo: one element in every UI slot, a command, a keybind, a toast. Not published.
// Copy to <home>/.t3-patcher/plugins/demo-slots/ (the folder name must equal the manifest id).
const SLOTS = ["sidebarSection", "threadHeader", "composerBanner", "rightPanel", "statusBar", "settingsPage", "timelineRowDecorator", "contextMenuItem"];

export async function start(t3) {
  t3.settings.define([
    { key: "label", type: "string", default: "demo", label: "Label", description: "Text shown in every demo element." },
    { key: "loud", type: "boolean", default: false, label: "Loud", description: "Bold text." },
    { key: "level", type: "enum", default: "b", label: "Level", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  ]);

  for (const slot of SLOTS) {
    t3.ui.register({
      slot,
      id: `demo-${slot}`,
      title: "Demo",
      render(host, ctx) {
        const el = document.createElement("div");
        el.dataset.demoSlot = slot;
        el.style.cssText = "font-size:11px;padding:2px 6px;border:1px dashed var(--border, #888);border-radius:6px;color:var(--foreground, inherit)";
        const paint = () => {
          el.textContent = `${t3.settings.get("label")} · ${slot}${ctx.threadId ? ` · ${ctx.threadId.slice(0, 8)}` : ""}`;
          el.style.fontWeight = t3.settings.get("loud") ? "700" : "400";
        };
        paint();
        const off = t3.settings.onChange(paint);
        host.appendChild(el);
        return () => off();
      },
    });
  }

  t3.commands.register({
    id: "hello",
    title: "Demo: say hello",
    description: "demo-slots",
    keywords: ["demo", "hello"],
    run: () => {
      globalThis.__t3p_demo = { ranAt: Date.now(), count: (globalThis.__t3p_demo?.count ?? 0) + 1 };
      t3.ui.toast({ title: "demo-slots", message: "hello from the demo command", kind: "success" });
    },
  });
  t3.keybinds.register({ id: "hello", key: "alt+shift+h", command: "demo-slots:hello" });
}
