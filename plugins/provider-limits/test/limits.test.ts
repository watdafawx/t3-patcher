import { describe, expect, it } from "vitest";

import {
  barPercent,
  buildProviderViews,
  classifyPercent,
  DEFAULT_THRESHOLDS,
  formatAuth,
  formatChipText,
  formatCountdown,
  formatPercent,
  formatProviderFlags,
  formatResetCredits,
  formatWindowDuration,
  limitsNote,
  limitsNoteText,
  parseIso,
  pickWorst,
  providerLabel,
  windowsOf,
} from "../src/limits.js";
import {
  bareProvider,
  claudeProvider,
  codexProvider,
  emptyWindowsProvider,
  makeProvider,
  NOW,
  unavailableProvider,
} from "./fixtures.js";

describe("classifyPercent", () => {
  it("uses the default 80/95 thresholds (0..100 scale)", () => {
    expect(classifyPercent(0)).toBe("ok");
    expect(classifyPercent(79.9)).toBe("ok");
    expect(classifyPercent(80)).toBe("warn");
    expect(classifyPercent(94.99)).toBe("warn");
    expect(classifyPercent(95)).toBe("critical");
    expect(classifyPercent(100)).toBe("critical");
    expect(DEFAULT_THRESHOLDS).toEqual({ warnThreshold: 80, criticalThreshold: 95 });
  });

  it("accepts custom thresholds", () => {
    const thresholds = { warnThreshold: 50, criticalThreshold: 85 };
    expect(classifyPercent(49, thresholds)).toBe("ok");
    expect(classifyPercent(50, thresholds)).toBe("warn");
    expect(classifyPercent(85, thresholds)).toBe("critical");
  });

  it("treats a non-number as ok", () => {
    expect(classifyPercent(Number.NaN)).toBe("ok");
  });
});

describe("provider helpers", () => {
  it("prefers the display name, then the driver, then the instance id", () => {
    expect(providerLabel(codexProvider())).toBe("Codex");
    expect(providerLabel(claudeProvider())).toBe("claudeAgent");
    expect(providerLabel(makeProvider({ instanceId: "x", driver: "driver", displayName: "  " }))).toBe("driver");
  });

  it("returns an empty window list when usageLimits is absent", () => {
    expect(windowsOf(bareProvider())).toEqual([]);
    expect(windowsOf(unavailableProvider())).toEqual([]);
    expect(windowsOf(claudeProvider())).toHaveLength(3);
  });

  it("formats auth state with an optional account label", () => {
    expect(formatAuth({ status: "authenticated" })).toBe("authenticated");
    expect(formatAuth({ status: "authenticated", email: "dev@example.com" })).toBe("authenticated (dev@example.com)");
    expect(formatAuth({ status: "authenticated", label: "  ", email: "dev@example.com" })).toBe(
      "authenticated (dev@example.com)",
    );
    expect(formatAuth({ status: "unknown" })).toBe("unknown");
  });

  it("formats enabled/installed/version flags", () => {
    expect(formatProviderFlags(claudeProvider())).toBe("enabled");
    expect(formatProviderFlags(unavailableProvider())).toBe("disabled · not installed");
    expect(formatProviderFlags(makeProvider({ instanceId: "v", version: "1.2.3" }))).toBe("enabled · v1.2.3");
  });
});

describe("parseIso", () => {
  it("parses valid timestamps and rejects junk", () => {
    expect(parseIso("2026-11-18T21:30:00.000Z")).toBe(NOW);
    expect(parseIso(undefined)).toBeNull();
    expect(parseIso(null)).toBeNull();
    expect(parseIso("")).toBeNull();
    expect(parseIso("not a date")).toBeNull();
  });
});

describe("percent formatting", () => {
  it("rounds and clamps 0..100", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(42.4)).toBe("42%");
    expect(formatPercent(42.6)).toBe("43%");
    expect(formatPercent(120)).toBe("100%");
    expect(formatPercent(-5)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe("?%");
  });

  it("clamps the CSS bar width", () => {
    expect(barPercent(23)).toBe(23);
    expect(barPercent(140)).toBe(100);
    expect(barPercent(-1)).toBe(0);
    expect(barPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("formatCountdown", () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  it("prints days, hours and minutes, dropping empty parts", () => {
    expect(formatCountdown(NOW + 3 * hour + 12 * minute, NOW)).toBe("in 3h 12m");
    expect(formatCountdown(NOW + 3 * hour, NOW)).toBe("in 3h");
    expect(formatCountdown(NOW + 4 * day + 2 * hour, NOW)).toBe("in 4d 2h");
    expect(formatCountdown(NOW + 4 * day, NOW)).toBe("in 4d");
    expect(formatCountdown(NOW + 12 * minute, NOW)).toBe("in 12m");
    expect(formatCountdown(NOW + 30_000, NOW)).toBe("in <1m");
  });

  it("marks a past or exact reset time as overdue", () => {
    expect(formatCountdown(NOW, NOW)).toBe("reset overdue");
    expect(formatCountdown(NOW - 5 * minute, NOW)).toBe("reset overdue");
  });

  it("handles a missing timestamp", () => {
    expect(formatCountdown(null, NOW)).toBe("no reset time");
  });
});

describe("formatWindowDuration", () => {
  it("formats server window minutes", () => {
    expect(formatWindowDuration(300)).toBe("5h");
    expect(formatWindowDuration(10080)).toBe("7d");
    expect(formatWindowDuration(90)).toBe("1h 30m");
    expect(formatWindowDuration(45)).toBe("45m");
  });

  it("is empty when the server reports nothing usable", () => {
    expect(formatWindowDuration(undefined)).toBe("");
    expect(formatWindowDuration(null)).toBe("");
    expect(formatWindowDuration(0)).toBe("");
  });
});

describe("limitsNote", () => {
  it("distinguishes absent limits, empty windows and an unavailable probe", () => {
    expect(limitsNote(undefined)).toEqual({ kind: "no-data" });
    expect(limitsNoteText(limitsNote(undefined))).toBe("no limit data");

    expect(limitsNote(emptyWindowsProvider().usageLimits)).toEqual({ kind: "no-windows" });
    expect(limitsNoteText(limitsNote(emptyWindowsProvider().usageLimits))).toBe("no windows reported");

    const unavailable = limitsNote(unavailableProvider().usageLimits);
    expect(unavailable).toEqual({ kind: "unavailable", reason: "unsupported", message: null });
    expect(limitsNoteText(unavailable)).toBe("limits unavailable (unsupported)");

    expect(limitsNote(claudeProvider().usageLimits)).toEqual({ kind: "ok" });
    expect(limitsNoteText({ kind: "ok" })).toBe("");
  });

  it("includes the server's message when it sends one", () => {
    const limits = {
      checkedAt: "2026-11-18T21:35:13.272Z",
      windows: [],
      unavailable: { reason: "probeFailed" as const, message: "token expired" },
    };
    expect(limitsNoteText(limitsNote(limits))).toBe("limits unavailable (probeFailed): token expired");
  });
});

describe("formatResetCredits", () => {
  it("shows the available count and next expiry", () => {
    const text = formatResetCredits(claudeProvider().usageLimits?.resetCredits, NOW);
    expect(text).toMatch(/^1 reset credit · next expires in \d+d/);
  });

  it("omits the expiry when none is reported", () => {
    expect(formatResetCredits(codexProvider().usageLimits?.resetCredits, NOW)).toBe("0 reset credits");
    expect(formatResetCredits(undefined, NOW)).toBeNull();
  });
});

describe("pickWorst", () => {
  it("picks the highest used percent across all instances and windows", () => {
    const worst = pickWorst([claudeProvider(), codexProvider()], DEFAULT_THRESHOLDS);
    expect(worst).not.toBeNull();
    expect(worst?.instanceId).toBe("codex");
    expect(worst?.windowId).toBe("secondary");
    expect(worst?.windowLabel).toBe("Weekly");
    expect(worst?.providerLabel).toBe("Codex");
    expect(worst?.usedPercent).toBe(76);
    expect(worst?.level).toBe("ok");
    expect(worst?.resetsAtMs).toBe(Date.parse("2026-11-23T12:53:59.000Z"));
  });

  it("classifies the winner with the active thresholds", () => {
    expect(pickWorst([claudeProvider(), codexProvider()], { warnThreshold: 70, criticalThreshold: 90 })?.level).toBe("warn");
    expect(pickWorst([claudeProvider(), codexProvider()], { warnThreshold: 70, criticalThreshold: 75 })?.level).toBe(
      "critical",
    );
  });

  it("ignores providers with no limits and empty windows", () => {
    expect(pickWorst([bareProvider(), unavailableProvider(), emptyWindowsProvider()])).toBeNull();
    expect(pickWorst([])).toBeNull();
  });

  it("breaks ties by the earlier reset, then the lower instance and window ids", () => {
    const window = (id: string, usedPercent: number, resetsAt?: string) => ({
      id,
      kind: "session" as const,
      label: id,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
    const limits = (windows: ReturnType<typeof window>[]) => ({ checkedAt: "2026-11-18T21:25:04.493Z", windows });

    const earlier = makeProvider({
      instanceId: "alpha",
      usageLimits: limits([window("w", 50, "2026-11-19T00:00:00.000Z")]),
    });
    const later = makeProvider({
      instanceId: "beta",
      usageLimits: limits([window("w", 50, "2026-11-20T00:00:00.000Z")]),
    });
    expect(pickWorst([later, earlier])?.instanceId).toBe("alpha");

    const noReset = makeProvider({ instanceId: "gamma", usageLimits: limits([window("w", 50)]) });
    expect(pickWorst([noReset, later])?.instanceId).toBe("beta");

    const sameResetA = makeProvider({
      instanceId: "delta",
      usageLimits: limits([window("a", 60, "2026-11-19T00:00:00.000Z"), window("b", 60, "2026-11-19T00:00:00.000Z")]),
    });
    expect(pickWorst([sameResetA])?.windowId).toBe("a");
  });
});

describe("formatChipText", () => {
  it("summarises the worst window with provider and countdown", () => {
    const worst = pickWorst([claudeProvider(), codexProvider()]);
    expect(formatChipText(worst, NOW)).toBe("Codex 76% · in 4d 15h");
  });

  it("handles no data", () => {
    expect(formatChipText(null, NOW)).toBe("Limits: no data");
  });
});

describe("buildProviderViews", () => {
  it("keeps server order and formats every provider and window", () => {
    const views = buildProviderViews([codexProvider(), claudeProvider()], DEFAULT_THRESHOLDS, NOW);
    expect(views.map((view) => view.instanceId)).toEqual(["codex", "claudeAgent"]);

    const claude = views[1];
    expect(claude?.label).toBe("claudeAgent");
    expect(claude?.status).toBe("ready");
    expect(claude?.authText).toBe("authenticated (dev@example.com)");
    expect(claude?.flags).toBe("enabled");
    expect(claude?.note.kind).toBe("ok");
    expect(claude?.noteText).toBe("");
    expect(claude?.resetCreditsText).toMatch(/^1 reset credit/);
    expect(claude?.windows).toHaveLength(3);

    const session = claude?.windows[0];
    expect(session).toMatchObject({
      id: "five_hour",
      label: "Session",
      kind: "session",
      percentText: "23%",
      barPercent: 23,
      level: "ok",
      resetCountdown: "in 4h",
      durationText: "5h window",
    });

    const weekly = views[0]?.windows[1];
    expect(weekly?.percentText).toBe("76%");
    expect(weekly?.durationText).toBe("7d window");
    expect(weekly?.resetCountdown).toBe("in 4d 15h");
  });

  it("shows 'no limit data' for a provider without usageLimits", () => {
    const [view] = buildProviderViews([bareProvider()], DEFAULT_THRESHOLDS, NOW);
    expect(view?.note.kind).toBe("no-data");
    expect(view?.noteText).toBe("no limit data");
    expect(view?.windows).toEqual([]);
    expect(view?.resetCreditsText).toBeNull();
    expect(view?.authText).toBe("unauthenticated");
  });

  it("shows the unavailable note for a probe that could not measure", () => {
    const [view] = buildProviderViews([unavailableProvider()], DEFAULT_THRESHOLDS, NOW);
    expect(view?.noteText).toBe("limits unavailable (unsupported)");
    expect(view?.status).toBe("disabled");
    expect(view?.windows).toEqual([]);
  });

  it("handles empty windows and resets in the past", () => {
    const past = makeProvider({
      instanceId: "past",
      usageLimits: {
        checkedAt: "2026-11-18T21:25:04.493Z",
        windows: [
          {
            id: "w",
            kind: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: "2026-11-01T00:00:00.000Z",
            windowDurationMins: 0,
          },
        ],
      },
    });
    const views = buildProviderViews([emptyWindowsProvider(), past], DEFAULT_THRESHOLDS, NOW);
    expect(views[0]?.noteText).toBe("no windows reported");
    expect(views[1]?.windows[0]?.resetCountdown).toBe("reset overdue");
    expect(views[1]?.windows[0]?.level).toBe("critical");
    expect(views[1]?.windows[0]?.durationText).toBe("");
  });
});
