/**
 * provider-limits: a status bar chip, a live limits panel and warn/critical toasts, built
 * only on the public `t3` API (`t3.providers`, `t3.ui`, `t3.settings` and `t3.commands`).
 *
 * Data flow: one shared snapshot (`t3.providers.list()` plus `onChange` and the periodic
 * `t3.providers.refresh()`), one 1 s tick for countdowns, and one subscriber set for the
 * chip and panel. Everything is released from the returned cleanup (and `stop`).
 */

import { T3PermissionError, type PluginModule, type ProviderSnapshot, type SettingSchema, type T3Api, type T3Disposable, type TurnStartDecision, type Unsubscribe } from "@t3p/api";

import { detectCrossings, type CrossingState } from "./crossings.js";
import { ChoiceMemory, DEFAULT_GUARD_THRESHOLD, evaluateTurn } from "./guard.js";
import { DEFAULT_THRESHOLDS, formatPercent, type LimitThresholds } from "./limits.js";
import { parseFavorites, type FavoriteModel } from "./model.js";
import { mountChip, mountPanel, type PanelSource } from "./panel.js";
import { ComposerHosts, createPrompter, parsePresentation } from "./prompt.js";

const TITLE = "Provider limits";

const SETTINGS: SettingSchema[] = [
  {
    key: "warnThreshold",
    type: "number",
    default: 80,
    min: 0,
    max: 100,
    label: "Warn threshold",
    description: "Used percent at which a limit window turns yellow (0-100).",
  },
  {
    key: "criticalThreshold",
    type: "number",
    default: 95,
    min: 0,
    max: 100,
    label: "Critical threshold",
    description: "Used percent at which a limit window turns red (0-100).",
  },
  {
    key: "showChip",
    type: "boolean",
    default: true,
    label: "Show the status bar chip",
    description: "Shows the worst-case provider limit in the T3 Patcher status bar.",
  },
  {
    key: "refreshSeconds",
    type: "number",
    default: 60,
    min: 5,
    max: 3600,
    label: "Refresh interval (seconds)",
    description: "How often to re-probe providers with t3.providers.refresh().",
  },
  {
    key: "guardThresholdPercent",
    type: "number",
    default: DEFAULT_GUARD_THRESHOLD,
    min: 0,
    max: 100,
    label: "Ask before a turn below (% left)",
    description:
      "Before a message, new thread or delegated task starts on a provider with less than this percent left in any limit window, ask to switch, keep going or cancel. 0 turns it off. Needs the guard permission (t3p grant provider-limits guard).",
  },
  {
    key: "guardUseFavorites",
    type: "boolean",
    default: true,
    label: "Switch to a favorite model",
    description:
      "When a turn is about to start on a nearly empty provider, propose your favorite models (in your order) whose provider still has headroom in its session and weekly windows. Off = only the fallback model below, then each other provider's default model.",
  },
  {
    key: "guardFallback",
    type: "string",
    default: "",
    label: "Fallback model (override)",
    description: "Optional. Tried before your favorites when it has headroom: <provider instance>:<model> (for example codex:gpt-5.4), or just a model on the same provider. Empty = favorites only.",
  },
  {
    key: "guardPresentation",
    type: "enum",
    default: "toast",
    options: [
      { value: "toast", label: "Toast (bottom right)" },
      { value: "composer", label: "Banner above the composer" },
    ],
    label: "Where to ask",
    description: "The low-quota question shows as a toast, or as a banner docked above the prompt box. The banner falls back to the toast when no composer is on screen.",
  },
];

/** The guard handler waits for the modal this long; the turn then runs anyway. */
const GUARD_TIMEOUT_MS = 120_000;

const MIN_REFRESH_SECONDS = 5;
const MAX_REFRESH_SECONDS = 3600;

/** `stop()` reaches the controller of the current load through this slot. */
let stopCurrent: (() => void) | null = null;

const plugin: PluginModule = {
  start(t3: T3Api) {
    t3.settings.define(SETTINGS);

    const state = {
      providers: [] as ProviderSnapshot[],
      loading: true,
      error: null as string | null,
      nowMs: Date.now(),
    };
    let thresholds = readThresholds(t3);
    let crossings: CrossingState | null = null;
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let inFlight: Promise<void> | null = null;
    let panelOpen = false;
    let stopped = false;
    const listeners = new Set<() => void>();

    const notify = (): void => {
      if (stopped) return;
      state.nowMs = Date.now();
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          t3.log("warn", `panel update failed: ${errorMessage(error)}`);
        }
      }
    };

    const subscribe = (callback: () => void): Unsubscribe => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    };

    const source: PanelSource = {
      providers: () => state.providers,
      loading: () => state.loading,
      error: () => state.error,
      thresholds: () => thresholds,
      now: () => state.nowMs,
      onChange: subscribe,
      refresh: () => {
        void load(true);
      },
      themeVars: () => {
        try {
          return t3.ui.themeVars();
        } catch {
          return {};
        }
      },
    };

    const checkCrossings = (providers: readonly ProviderSnapshot[]): void => {
      const result = detectCrossings(crossings, providers, thresholds);
      crossings = result.state;
      for (const event of result.events) {
        t3.ui.toast({
          title: TITLE,
          message: `${event.providerLabel} ${event.windowLabel} at ${formatPercent(event.usedPercent)} (${event.to})`,
          kind: event.to === "critical" ? "error" : "warning",
          durationMs: 8000,
        });
      }
    };

    const apply = (providers: ProviderSnapshot[]): void => {
      state.providers = providers;
      state.loading = false;
      state.error = null;
      checkCrossings(providers);
      notify();
    };

    /** Loads the cached list, or re-probes the server with `force`. Never overlaps. */
    function load(force: boolean): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const providers = force ? await t3.providers.refresh() : await t3.providers.list();
          if (!stopped) apply(providers);
        } catch (error) {
          if (!stopped) {
            state.loading = false;
            state.error = errorMessage(error);
            notify();
          }
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    }

    async function refreshManually(): Promise<void> {
      await load(true);
      if (stopped) return;
      if (state.error) {
        t3.ui.toast({ title: TITLE, message: `Refresh failed: ${state.error}`, kind: "error" });
      } else {
        t3.ui.toast({ title: TITLE, message: "Providers refreshed.", kind: "success" });
      }
    }

    async function openPanel(): Promise<void> {
      if (panelOpen || stopped) return;
      panelOpen = true;
      try {
        await t3.ui.modal({
          title: TITLE,
          body: (host) => mountPanel(host, source, { header: false }),
          buttons: ["Close"],
        });
      } catch (error) {
        t3.log("warn", `could not open the panel: ${errorMessage(error)}`);
      } finally {
        panelOpen = false;
      }
    }

    function startRefreshTimer(): void {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      const seconds = clampRefreshSeconds(Number(t3.settings.get("refreshSeconds")));
      refreshTimer = setInterval(() => {
        void load(true);
      }, seconds * 1000);
    }

    const offSettings = t3.settings.onChange((change) => {
      if (change.key === "warnThreshold" || change.key === "criticalThreshold") {
        thresholds = readThresholds(t3);
        // Reseed without alerts: changing a threshold must not fire a toast by itself.
        crossings = detectCrossings(null, state.providers, thresholds).state;
        notify();
        return;
      }
      if (change.key === "refreshSeconds") startRefreshTimer();
      notify();
    });

    let offProviders: Unsubscribe = () => undefined;
    try {
      offProviders = t3.providers.onChange((providers) => {
        if (!stopped) apply(providers);
      });
    } catch (error) {
      state.loading = false;
      state.error = errorMessage(error);
    }

    const chipSlot = t3.ui.register({
      slot: "statusBar",
      id: "chip",
      title: TITLE,
      order: 10,
      render(host, context) {
        const off = mountChip(host, source, () => Boolean(t3.settings.get("showChip")), () => {
          void openPanel();
        });
        const offTheme = context.onThemeChange(notify);
        return () => {
          offTheme();
          off();
        };
      },
    });

    const panelSlot = t3.ui.register({
      slot: "rightPanel",
      id: "panel",
      title: TITLE,
      order: 10,
      render(host, context) {
        const off = mountPanel(host, source, { header: true });
        const offTheme = context.onThemeChange(notify);
        return () => {
          offTheme();
          off();
        };
      },
    });

    const commands = [
      t3.commands.register({
        id: "refresh-now",
        title: "Provider limits: refresh now",
        description: "Re-probe provider usage limits",
        keywords: ["provider", "limits", "usage", "refresh"],
        run: () => refreshManually(),
      }),
      t3.commands.register({
        id: "open-panel",
        title: "Provider limits: open panel",
        description: "Open the provider limits panel",
        keywords: ["provider", "limits", "usage", "panel"],
        run: () => openPanel(),
      }),
    ];

    tickTimer = setInterval(notify, 1000);
    startRefreshTimer();
    void load(false);

    // WP-6C / WP-11A: ask before a turn starts on a nearly exhausted provider.
    const memory = new ChoiceMemory();
    const hosts = new ComposerHosts();
    const composerSlot = t3.ui.register({
      slot: "composerBanner",
      id: "guard",
      order: 0,
      render(host, context) {
        // The slot host only holds the guard banner while a prompt is open; empty otherwise.
        return hosts.add(host, context.threadId);
      },
    });
    const prompter = createPrompter({
      toast: (options) => t3.ui.toast(options),
      presentation: () => parsePresentation(t3.settings.get("guardPresentation")),
      hosts,
      memory,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      timeoutMs: GUARD_TIMEOUT_MS - 2_000,
    });
    /** The user's favorite models: `server.getConfig().settings.favorites` (null = unmigrated, then none). */
    const readFavorites = async (): Promise<FavoriteModel[]> => {
      try {
        const config = (await t3.rpc.call("server.getConfig", {})) as { settings?: { favorites?: unknown } } | null;
        return parseFavorites(config?.settings?.favorites);
      } catch (error) {
        t3.log("warn", `could not read favorite models: ${errorMessage(error)}`);
        return [];
      }
    };
    let guardHandle: T3Disposable | null = null;
    try {
      guardHandle = t3.threads.beforeStart(
        async (ctx): Promise<TurnStartDecision> => {
          if (state.providers.length === 0) await load(false).catch(() => undefined);
          const settings = {
            thresholdPercent: Number(t3.settings.get("guardThresholdPercent")),
            fallback: String(t3.settings.get("guardFallback") ?? ""),
            useFavorites: t3.settings.get("guardUseFavorites") !== false,
          };
          const quick = evaluateTurn(ctx, state.providers, settings, memory, Date.now());
          if (quick.kind === "pass") return { action: "allow" };
          if (quick.kind === "decided" && !settings.useFavorites) return quick.decision;
          // The turn needs a fallback: read the favorites now (cheap, one RPC, only on a low-quota turn).
          const favorites = settings.useFavorites ? await readFavorites() : [];
          const evaluation = evaluateTurn(ctx, state.providers, settings, memory, Date.now(), favorites);
          if (evaluation.kind === "pass") return { action: "allow" };
          if (evaluation.kind === "decided") return evaluation.decision;
          return prompter.ask(ctx, evaluation);
        },
        { timeoutMs: GUARD_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof T3PermissionError) t3.log("info", "turn guard off: grant the guard permission (t3p grant provider-limits guard) to ask before low-quota turns");
      else t3.log("warn", `turn guard unavailable: ${errorMessage(error)}`);
    }

    const cleanup = (): void => {
      if (stopped) return;
      stopped = true;
      if (tickTimer !== null) clearInterval(tickTimer);
      if (refreshTimer !== null) clearInterval(refreshTimer);
      tickTimer = null;
      refreshTimer = null;
      offSettings();
      offProviders();
      listeners.clear();
      chipSlot.dispose();
      panelSlot.dispose();
      for (const command of commands) command.dispose();
      guardHandle?.dispose();
      prompter.dispose();
      composerSlot.dispose();
      memory.clear();
      if (stopCurrent === cleanup) stopCurrent = null;
    };
    stopCurrent = cleanup;
    return cleanup;
  },

  stop() {
    stopCurrent?.();
  },
};

function readThresholds(t3: T3Api): LimitThresholds {
  const warn = Number(t3.settings.get<number>("warnThreshold"));
  const critical = Number(t3.settings.get<number>("criticalThreshold"));
  return {
    warnThreshold: Number.isFinite(warn) ? warn : DEFAULT_THRESHOLDS.warnThreshold,
    criticalThreshold: Number.isFinite(critical) ? critical : DEFAULT_THRESHOLDS.criticalThreshold,
  };
}

function clampRefreshSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 60;
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(seconds)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default plugin;
