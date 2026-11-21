import type { JsonValue, PluginModule, T3Api } from "@t3p/api";

interface ServerSource {
  harness: string;
  scope: "global" | "project";
  path: string;
  name: string;
}

interface ServerStatus {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  enabled: boolean;
  mode: "shared" | "session";
  pinnedTools?: string[];
  harnesses?: string[];
  source?: ServerSource;
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
  claudeDesktop: string;
  codex: string;
  opencode: string;
}

interface DiscoveredOrigin {
  harness: string;
  scope: "global" | "project";
  path: string;
  name: string;
  label: string;
}

interface DiscoveryCandidate {
  key: string;
  name: string;
  suggestedId: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  envKeys: string[];
  headerKeys: string[];
  origins: DiscoveredOrigin[];
  warnings: string[];
  importedId: string | null;
}

interface ScanResult {
  scannedAt: number;
  harnessLabels: Record<string, string>;
  candidates: DiscoveryCandidate[];
  warnings: Array<{ harness: string; path: string; message: string }>;
}

interface HarnessLink {
  id: string;
  label: string;
  harness: string;
  scope: "global" | "project";
  path: string;
  exists: boolean;
  connected: boolean;
  error: string | null;
}

interface HarnessLinks {
  url: string;
  targets: HarnessLink[];
}

const HARNESS_OPTIONS = ["claude", "claude-desktop", "codex", "opencode", "cursor", "vscode", "antigravity"];

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
[data-t3p-plugin="mcp-relay"] .mr-cand{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--border,color-mix(in srgb,currentColor 10%,transparent))}
[data-t3p-plugin="mcp-relay"] .mr-check{margin-top:3px}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function harnessList(ids: string[] | undefined): string {
  if (!ids || ids.length === 0) return "all harnesses";
  return ids.join(", ");
}

const plugin: PluginModule = {
  start(t3: T3Api) {
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLE;
    document.head.append(styleEl);

    let latest: RelayStatus | null = null;
    let scan: ScanResult | null = null;
    let scanning = false;
    let links: HarnessLinks | null = null;
    let linksBusy = false;
    const selected = new Set<string>();
    const sourceChoice = new Map<string, number>();
    let extraPaths = "";
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

    const runScan = async () => {
      scanning = true;
      notify();
      try {
        scan = (await t3.native.invoke("scanHarnesses", {
          paths: extraPaths
            .split(/\r?\n/)
            .map((p) => p.trim())
            .filter(Boolean),
        })) as ScanResult;
        selected.clear();
        for (const candidate of scan.candidates) {
          if (!candidate.importedId && candidate.origins.length > 1 && !sourceChoice.has(candidate.key)) {
            sourceChoice.set(candidate.key, 0);
          }
        }
      } catch {
        scan = null;
      } finally {
        scanning = false;
        notify();
      }
    };

    const loadLinks = async () => {
      try {
        links = (await t3.native.invoke("harnessLinks")) as HarnessLinks;
      } catch {
        links = null;
      }
      notify();
    };

    const setLinks = async (action: "connect" | "disconnect", ids?: string[]) => {
      linksBusy = true;
      notify();
      try {
        const result = (await t3.native.invoke("setHarnessLinks", {
          action,
          ...(ids ? { ids } : {}),
        })) as { links: HarnessLinks };
        links = result.links;
      } catch {
        /* keep previous state */
      } finally {
        linksBusy = false;
        notify();
      }
    };

    void refresh();
    void loadLinks();
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
              ["Copy Claude Code JSON", snippets.claude],
              ["Copy Claude Desktop JSON", snippets.claudeDesktop],
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

          // 2. Harness connections (auto-write the relay entry)
          const linksCard = el("div", "mr-card");
          linksCard.append(el("strong", "", "Harness connections"));
          linksCard.append(
            el(
              "div",
              "mr-muted",
              "Relay adds only a \"t3-relay\" entry to each harness config below, keeps a one-time *.t3p-backup, and removes only that entry on disconnect.",
            ),
          );
          if (!links) {
            linksCard.append(el("div", "mr-muted", "Loading…"));
          } else {
            const allRow = el("div", "mr-row");
            const connectAll = el("button", "t3p-btn", linksBusy ? "Working…" : "Connect all");
            connectAll.type = "button";
            (connectAll as HTMLButtonElement).disabled = linksBusy;
            connectAll.addEventListener("click", () => void setLinks("connect"));
            const disconnectAll = el("button", "t3p-btn", "Disconnect all");
            disconnectAll.type = "button";
            (disconnectAll as HTMLButtonElement).disabled = linksBusy;
            disconnectAll.addEventListener("click", () => void setLinks("disconnect"));
            allRow.append(connectAll, disconnectAll);
            linksCard.append(allRow);

            for (const target of links.targets) {
              if (!target.exists && target.scope === "project") continue;
              const row = el("div", "mr-row");
              const dot = el("span", `mr-dot ${target.connected ? "ok" : target.exists ? "idle" : "err"}`);
              const info = el("div", "mr-grow");
              const head = el("div", "mr-row");
              head.append(
                el("strong", "", target.label),
                el("span", "mr-badge", target.scope),
                el("span", "mr-badge", target.connected ? "connected" : target.exists ? "not connected" : "not installed"),
              );
              info.append(head);
              info.append(el("div", "mr-mono mr-muted", target.path));
              if (target.error) info.append(el("div", "mr-err", target.error));

              if (target.exists) {
                const btn = el("button", "t3p-btn", target.connected ? "Disconnect" : "Connect");
                btn.type = "button";
                (btn as HTMLButtonElement).disabled = linksBusy;
                btn.addEventListener("click", () => {
                  void setLinks(target.connected ? "disconnect" : "connect", [target.id]);
                });
                row.append(dot, info, btn);
              } else {
                row.append(dot, info);
              }
              linksCard.append(row);
            }
          }
          root.append(linksCard);

          // 2. Discover servers from harness configs
          const discoverCard = el("div", "mr-card");
          discoverCard.append(el("strong", "", "Installed in your harnesses"));
          discoverCard.append(
            el(
              "div",
              "mr-muted",
              "Finds MCP servers already configured in Claude Code, Claude Desktop, OpenCode, Codex, Cursor and VS Code. Imported servers keep a reference to the original config, so tokens are read at spawn and never copied into the relay config.",
            ),
          );

          const pathsInput = el("textarea", "t3p-input");
          pathsInput.placeholder = "Extra project folders to scan (one per line, optional)";
          pathsInput.rows = 2;
          pathsInput.value = extraPaths;
          pathsInput.addEventListener("input", () => {
            extraPaths = pathsInput.value;
          });

          const scanRow = el("div", "mr-row");
          const scanBtn = el("button", "t3p-btn", scanning ? "Scanning…" : "Detect installed MCPs");
          scanBtn.type = "button";
          (scanBtn as HTMLButtonElement).disabled = scanning;
          scanBtn.addEventListener("click", () => void runScan());
          scanRow.append(scanBtn);
          discoverCard.append(pathsInput, scanRow);

          if (scan) {
            if (scan.candidates.length === 0) {
              discoverCard.append(el("div", "mr-muted", "No MCP servers found in the scanned config files."));
            }
            for (const candidate of scan.candidates) {
              discoverCard.append(renderCandidate(candidate, scan));
            }
            if (scan.warnings.length > 0) {
              const warnLines = scan.warnings.map((w) => `${w.harness}: ${w.message} (${w.path})`);
              discoverCard.append(el("pre", "mr-pre", warnLines.join("\n")));
            }

            const importRow = el("div", "mr-row");
            const importBtn = el("button", "t3p-btn", `Import selected (${selected.size})`);
            importBtn.type = "button";
            (importBtn as HTMLButtonElement).disabled = selected.size === 0;
            importBtn.addEventListener("click", async () => {
              const selections: JsonValue = Array.from(selected)
                .map((key) => {
                  const candidate = scan?.candidates.find((c) => c.key === key);
                  if (!candidate) return null;
                  return {
                    key,
                    id: candidate.suggestedId,
                    sourceIndex: sourceChoice.get(key) ?? 0,
                    harnesses: [],
                  };
                })
                .filter(Boolean) as JsonValue[];
              if (selections.length === 0) return;
              latest = (await t3.native.invoke("importServers", {
                paths: extraPaths
                  .split(/\r?\n/)
                  .map((p) => p.trim())
                  .filter(Boolean),
                selections,
              })) as RelayStatus;
              selected.clear();
              await runScan();
            });
            importRow.append(importBtn, el("span", "mr-muted", "Servers connect lazily on first tool call."));
            discoverCard.append(importRow);
          }
          root.append(discoverCard);

          // 3. Servers list
          const listCard = el("div", "mr-card");
          listCard.append(el("strong", "", `Configured MCP Servers (${latest?.servers.length ?? 0})`));
          if (!latest || latest.servers.length === 0) {
            listCard.append(el("div", "mr-muted", "No MCP servers added yet. Import some above, or add one manually below."));
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

              const metaRow = el("div", "mr-row");
              if (srv.source) {
                metaRow.append(
                  el(
                    "span",
                    "mr-badge",
                    `from ${srv.source.harness}${srv.source.scope === "project" ? " (project)" : ""}`,
                  ),
                  el("span", "mr-muted", "values resolved at spawn"),
                );
              }
              if (srv.harnesses && srv.harnesses.length > 0) {
                metaRow.append(el("span", "mr-badge", `only ${harnessList(srv.harnesses)}`));
              } else {
                metaRow.append(el("span", "mr-badge", "all harnesses"));
              }

              const exposureSel = el("select", "t3p-input");
              for (const [value, label] of [
                ["", "Exposed to: all"],
                ...HARNESS_OPTIONS.map((h) => [h, `Exposed to: ${h}`] as const),
              ] as const) {
                exposureSel.append(new Option(label, value));
              }
              exposureSel.value = srv.harnesses && srv.harnesses.length === 1 ? srv.harnesses[0]! : "";
              exposureSel.addEventListener("change", async () => {
                const chosen = exposureSel.value;
                latest = (await t3.native.invoke("addServer", {
                  ...srv,
                  harnesses: chosen ? [chosen] : [],
                } as unknown as JsonValue)) as RelayStatus;
                notify();
              });
              metaRow.append(exposureSel);
              info.append(metaRow);
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

          // 4. Add server form
          const addCard = el("div", "mr-card");
          addCard.append(el("strong", "", "Add MCP Server Manually (live, no session restart)"));
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
          const harnessesInput = el("input", "t3p-input");
          harnessesInput.placeholder = "expose to (comma-separated harness ids, blank = all)";
          grid.append(idInput, transportSel, modeSel, cmdOrUrl, argsInput, pinnedInput, harnessesInput);

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
              const harnesses = harnessesInput.value
                .split(",")
                .map((s) => s.trim().toLowerCase())
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
                      harnesses,
                      enabled: true,
                    }
                  : {
                      id: idInput.value.trim(),
                      transport,
                      mode: modeSel.value,
                      url: cmdOrUrl.value.trim(),
                      pinnedTools,
                      harnesses,
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

          // 5. Recent call log
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

        const renderCandidate = (candidate: DiscoveryCandidate, result: ScanResult) => {
          const row = el("div", "mr-cand");
          const checkbox = el("input", "mr-check");
          checkbox.type = "checkbox";
          checkbox.disabled = Boolean(candidate.importedId);
          checkbox.checked = selected.has(candidate.key);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(candidate.key);
            else selected.delete(candidate.key);
            renderPage();
          });

          const info = el("div", "mr-grow");
          const head = el("div", "mr-row");
          head.append(
            el("strong", "", candidate.name),
            el("span", "mr-badge", candidate.transport),
          );
          for (const origin of candidate.origins) {
            head.append(el("span", "mr-badge", result.harnessLabels[origin.harness] ?? origin.harness));
          }
          if (candidate.importedId) head.append(el("span", "mr-badge", `imported as ${candidate.importedId}`));
          info.append(head);

          const detail = el("div", "mr-muted", candidate.transport === "stdio"
            ? `${candidate.command ?? ""} ${(candidate.args ?? []).join(" ")}`.trim()
            : candidate.url ?? "");
          info.append(detail);

          const facts: string[] = [];
          if (candidate.envKeys.length > 0) facts.push(`env: ${candidate.envKeys.join(", ")} (values read at spawn)`);
          if (candidate.headerKeys.length > 0) facts.push(`headers: ${candidate.headerKeys.join(", ")} (values read at spawn)`);
          if (facts.length > 0) info.append(el("div", "mr-muted", facts.join(" · ")));
          for (const warning of candidate.warnings) info.append(el("div", "mr-err", warning));

          if (candidate.origins.length > 1 && !candidate.importedId) {
            const originRow = el("div", "mr-row");
            originRow.append(el("span", "mr-muted", "Use values from:"));
            const originSel = el("select", "t3p-input");
            candidate.origins.forEach((origin, index) => {
              originSel.append(new Option(origin.label, String(index)));
            });
            originSel.value = String(sourceChoice.get(candidate.key) ?? 0);
            originSel.addEventListener("change", () => {
              sourceChoice.set(candidate.key, Number(originSel.value));
            });
            originRow.append(originSel);
            info.append(originRow);
          }

          row.append(checkbox, info);
          return row;
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
