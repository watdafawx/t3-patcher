import type { JsonValue, PluginModule, T3Api } from "@t3p/api";

interface ServerStatus {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  mode: "shared" | "session";
  pinnedTools?: string[];
  status: "connected" | "idle" | "disabled" | "error";
  toolCount: number;
  activeSessions: number;
  lastError: string | null;
}

interface CallLogEntry {
  id: string;
  timestamp: number;
  sessionId: string | null;
  serverId: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

interface RelayStatus {
  running: boolean;
  url: string;
  port: number;
  host: string;
  error: string | null;
  servers: ServerStatus[];
  recentCalls: CallLogEntry[];
}

interface RelaySnippets {
  url: string;
  claude: string;
  codex: string;
  opencode: string;
}

const STYLE = `
[data-t3p-plugin="mcp-relay"] .mr-col{display:flex;flex-direction:column;gap:10px}
[data-t3p-plugin="mcp-relay"] .mr-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
[data-t3p-plugin="mcp-relay"] .mr-card{border:1px solid var(--border,color-mix(in srgb,currentColor 14%,transparent));border-radius:var(--t3p-radius,8px);padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--card,transparent)}
[data-t3p-plugin="mcp-relay"] .mr-dot{width:8px;height:8px;border-radius:999px;display:inline-block;flex:none}
[data-t3p-plugin="mcp-relay"] .mr-dot.ok{background:var(--success,#22c55e)}
[data-t3p-plugin="mcp-relay"] .mr-dot.idle{background:var(--muted-foreground,#9ca3af)}
[data-t3p-plugin="mcp-relay"] .mr-dot.err{background:var(--destructive,#ef4444)}
[data-t3p-plugin="mcp-relay"] .mr-muted{font-size:12px;color:var(--muted-foreground,inherit)}
[data-t3p-plugin="mcp-relay"] .mr-mono{font-family:var(--font-mono,monospace);font-size:12px}
[data-t3p-plugin="mcp-relay"] .mr-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--border,color-mix(in srgb,currentColor 18%,transparent));color:var(--muted-foreground,inherit)}
[data-t3p-plugin="mcp-relay"] .mr-pre{margin:0;padding:8px;border-radius:6px;background:var(--code-background,var(--muted,color-mix(in srgb,currentColor 8%,transparent)));font-family:var(--font-mono,monospace);font-size:11px;overflow:auto;white-space:pre}
[data-t3p-plugin="mcp-relay"] .mr-grow{flex:1;min-width:0}
[data-t3p-plugin="mcp-relay"] .mr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
[data-t3p-plugin="mcp-relay"] .mr-err{font-size:12px;color:var(--destructive-foreground,var(--destructive,#ef4444))}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plugin: PluginModule = {
  start(t3: T3Api) {
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLE;
    document.head.append(styleEl);

    let latest: RelayStatus | null = null;
    const listeners = new Set<() => void>();

    const notify = () => {
      for (const fn of listeners) fn();
    };

    const refresh = async (): Promise<RelayStatus | null> => {
      try {
        latest = (await t3.native.invoke("status")) as RelayStatus;
      } catch {
        latest = null;
      }
      notify();
      return latest;
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 5000);

    const statusReg = t3.ui.register({
      slot: "statusBar",
      id: "mcp-relay-chip",
      render(host) {
        const chip = el("button", "t3p-chip");
        chip.type = "button";
        const update = () => {
          if (!latest) {
            chip.textContent = "MCP Relay: offline";
            return;
          }
          const active = latest.servers.filter((s) => s.enabled).length;
          chip.textContent = latest.running ? `MCP Relay · ${active} on` : "MCP Relay: stopped";
          chip.title = latest.running ? latest.url : (latest.error ?? "Not running");
        };
        chip.addEventListener("click", () => void refresh());
        listeners.add(update);
        update();
        host.append(chip);
        return () => {
          listeners.delete(update);
          chip.remove();
        };
      },
    });

    const settingsReg = t3.ui.register({
      slot: "settingsPage",
      id: "mcp-relay-settings",
      title: "MCP Relay",
      render(host) {
        const root = el("div", "mr-col");
        host.append(root);

        let snippets: RelaySnippets | null = null;
        void (t3.native.invoke("getSnippets") as Promise<RelaySnippets>)
          .then((s) => {
            snippets = s;
            renderPage();
          })
          .catch(() => {});

        const renderPage = () => {
          root.replaceChildren();

          // 1. Header / status card
          const statusCard = el("div", "mr-card");
          const topRow = el("div", "mr-row");
          const dot = el("span", `mr-dot ${latest?.running ? "ok" : "err"}`);
          const title = el("strong", "mr-grow", latest?.running ? `Relay active at ${latest.url}` : "Relay not running");
          const refreshBtn = el("button", "t3p-btn", "Refresh");
          refreshBtn.type = "button";
          refreshBtn.addEventListener("click", () => void refresh());
          topRow.append(dot, title, refreshBtn);
          statusCard.append(topRow);
          if (latest?.error) statusCard.append(el("div", "mr-err", latest.error));

          if (snippets) {
            const copyRow = el("div", "mr-row");
            for (const [label, text] of [
              ["Copy URL", snippets.url],
              ["Copy Claude JSON", snippets.claude],
              ["Copy Codex TOML", snippets.codex],
              ["Copy OpenCode JSON", snippets.opencode],
            ] as const) {
              const btn = el("button", "t3p-btn", label);
              btn.type = "button";
              btn.addEventListener("click", () => {
                void navigator.clipboard?.writeText(text);
              });
              copyRow.append(btn);
            }
            statusCard.append(copyRow);
          }
          root.append(statusCard);

          // 2. Servers list
          const listCard = el("div", "mr-card");
          listCard.append(el("strong", "", `Configured MCP Servers (${latest?.servers.length ?? 0})`));
          if (!latest || latest.servers.length === 0) {
            listCard.append(el("div", "mr-muted", "No MCP servers added yet. Add one below — running agents can use it immediately via relay_list_servers / relay_call."));
          } else {
            for (const srv of latest.servers) {
              const row = el("div", "mr-row");
              const sDot = el("span", `mr-dot ${srv.status === "connected" ? "ok" : srv.status === "error" ? "err" : "idle"}`);
              const info = el("div", "mr-grow");
              const head = el("div", "mr-row");
              head.append(
                el("strong", "", srv.id),
                el("span", "mr-badge", srv.transport),
                el("span", "mr-badge", srv.mode),
                el("span", "mr-muted", `${srv.status}${srv.toolCount ? ` · ${srv.toolCount} tools` : ""}`),
              );
              info.append(head);
              if (srv.lastError) info.append(el("div", "mr-err", srv.lastError));

              const toggleBtn = el("button", "t3p-btn", srv.enabled ? "Disable" : "Enable");
              toggleBtn.type = "button";
              toggleBtn.addEventListener("click", async () => {
                latest = (await t3.native.invoke("toggleServer", { id: srv.id, enabled: !srv.enabled })) as RelayStatus;
                notify();
              });

              const restartBtn = el("button", "t3p-btn", "Restart");
              restartBtn.type = "button";
              restartBtn.addEventListener("click", async () => {
                latest = (await t3.native.invoke("restartServer", { id: srv.id })) as RelayStatus;
                notify();
              });

              const rmBtn = el("button", "t3p-btn", "Remove");
              rmBtn.type = "button";
              rmBtn.addEventListener("click", async () => {
                latest = (await t3.native.invoke("removeServer", { id: srv.id })) as RelayStatus;
                notify();
              });

              row.append(sDot, info, toggleBtn, restartBtn, rmBtn);
              listCard.append(row);
            }
          }
          root.append(listCard);

          // 3. Add server form
          const addCard = el("div", "mr-card");
          addCard.append(el("strong", "", "Add MCP Server (live, no session restart)"));
          const grid = el("div", "mr-grid");
          const idInput = el("input", "t3p-input");
          idInput.placeholder = "id (e.g. github)";
          const transportSel = el("select", "t3p-input");
          transportSel.append(new Option("stdio", "stdio"), new Option("http", "http"));
          const modeSel = el("select", "t3p-input");
          modeSel.append(new Option("shared (1 process)", "shared"), new Option("session (per agent)", "session"));
          const cmdOrUrl = el("input", "t3p-input");
          cmdOrUrl.placeholder = "command (e.g. npx) or http://...";
          const argsInput = el("input", "t3p-input");
          argsInput.placeholder = "args (space-separated, stdio only)";
          const pinnedInput = el("input", "t3p-input");
          pinnedInput.placeholder = "pinned tools (comma-separated, optional)";
          grid.append(idInput, transportSel, modeSel, cmdOrUrl, argsInput, pinnedInput);

          const formErr = el("div", "mr-err");
          const addBtn = el("button", "t3p-btn", "Add Server");
          addBtn.type = "button";
          addBtn.addEventListener("click", async () => {
            formErr.textContent = "";
            try {
              const transport = transportSel.value as "stdio" | "http";
              const pinnedTools = pinnedInput.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const payload: JsonValue =
                transport === "stdio"
                  ? {
                      id: idInput.value.trim(),
                      transport,
                      mode: modeSel.value,
                      command: cmdOrUrl.value.trim(),
                      args: argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : [],
                      pinnedTools,
                      enabled: true,
                    }
                  : {
                      id: idInput.value.trim(),
                      transport,
                      mode: modeSel.value,
                      url: cmdOrUrl.value.trim(),
                      pinnedTools,
                      enabled: true,
                    };
              latest = (await t3.native.invoke("addServer", payload)) as RelayStatus;
              notify();
            } catch (err) {
              formErr.textContent = err instanceof Error ? err.message : String(err);
            }
          });
          addCard.append(grid, addBtn, formErr);
          root.append(addCard);

          // 4. Recent call log
          const logCard = el("div", "mr-card");
          logCard.append(el("strong", "", "Recent Relay Calls"));
          const calls = latest?.recentCalls ?? [];
          if (calls.length === 0) {
            logCard.append(el("div", "mr-muted", "No tool calls yet."));
          } else {
            const lines = calls
              .slice(0, 15)
              .map((c) => `${new Date(c.timestamp).toLocaleTimeString()} [${c.ok ? "OK" : "ERR"}] ${c.serverId}.${c.tool} (${c.durationMs}ms)${c.error ? ` — ${c.error}` : ""}`);
            logCard.append(el("pre", "mr-pre", lines.join("\n")));
          }
          root.append(logCard);
        };

        listeners.add(renderPage);
        renderPage();
        return () => {
          listeners.delete(renderPage);
          root.remove();
        };
      },
    });

    return () => {
      clearInterval(timer);
      statusReg.dispose();
      settingsReg.dispose();
      styleEl.remove();
    };
  },
};

export default plugin;
