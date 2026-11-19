/**
 * Synthetic provider snapshots for the unit tests.
 *
 * Values come from the recorded WP-0D fixtures:
 * `docs/spikes/wp-0d/fixtures/usage-limits-sample.json` (Claude's session/weekly/Fable
 * windows and reset credits, Codex's session/weekly pair) and
 * `docs/spikes/wp-0d/fixtures/server-getConfig.json` (the `opencode` entry with empty
 * windows and `unavailable: { reason: "unsupported" }`, and Claude's unauthenticated
 * entry without `usageLimits`). Types are the public ones from `@t3p/api`.
 */

import type { ProviderSnapshot } from "@t3p/api";

/** Fixed "now" for every countdown assertion: 2026-11-18T21:30:00.000Z. */
export const NOW = Date.parse("2026-11-18T21:30:00.000Z");

const CHECKED_AT = "2026-11-18T21:25:04.493Z";

type ProviderOverrides = Partial<ProviderSnapshot> & { instanceId: string };

/** Builds a complete `ProviderSnapshot` with neutral defaults. */
export function makeProvider(overrides: ProviderOverrides): ProviderSnapshot {
  const { instanceId, ...rest } = overrides;
  return {
    instanceId: instanceId as ProviderSnapshot["instanceId"],
    driver: instanceId as ProviderSnapshot["driver"],
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    ...rest,
  };
}

/** Claude as recorded in the WP-0D sample: 23% session, 42% weekly, 1% Fable, one reset credit. */
export function claudeProvider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return makeProvider({
    instanceId: "claudeAgent",
    status: "ready",
    auth: { status: "authenticated", email: "dev@example.com" },
    checkedAt: CHECKED_AT,
    usageLimits: {
      checkedAt: CHECKED_AT,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 23,
          resetsAt: "2026-11-19T01:30:00.049Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10080,
          usedPercent: 42,
          resetsAt: "2026-11-24T19:00:00.049Z",
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly — Fable",
          windowDurationMins: 10080,
          usedPercent: 1,
          resetsAt: "2026-11-24T19:00:00.049Z",
        },
      ],
      resetCredits: {
        availableCount: 1,
        nextExpiresAt: "2027-03-09T07:59:00.000Z",
        nextCreditId: "launch-2610-fable",
        options: [
          {
            creditId: "launch-2610-fable",
            label: "Fable reset",
            description: "Refills your Fable allowance.",
            availableCount: 1,
            expiresAt: "2027-03-09T07:59:00.000Z",
          },
        ],
      },
    },
    ...overrides,
  });
}

/** Codex as recorded in the WP-0D sample: 0% session, 76% weekly, no reset credits. */
export function codexProvider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return makeProvider({
    instanceId: "codex",
    displayName: "Codex",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-18T21:25:06.042Z",
    usageLimits: {
      checkedAt: "2026-11-18T21:25:06.042Z",
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: "2026-11-19T02:25:07.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 76,
          windowDurationMins: 10080,
          resetsAt: "2026-11-23T12:53:59.000Z",
        },
      ],
      resetCredits: { availableCount: 0 },
    },
    ...overrides,
  });
}

/** The recorded `opencode` entry: a provider that cannot measure, no windows. */
export function unavailableProvider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return makeProvider({
    instanceId: "opencode",
    status: "disabled",
    enabled: false,
    installed: false,
    auth: { status: "unknown" },
    checkedAt: "2026-11-18T21:35:13.272Z",
    usageLimits: {
      checkedAt: "2026-11-18T21:35:13.272Z",
      windows: [],
      unavailable: { reason: "unsupported" },
    },
    ...overrides,
  });
}

/** The recorded Claude entry from `server.getConfig`: unauthenticated, no `usageLimits`. */
export function bareProvider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return makeProvider({
    instanceId: "claudeAgent",
    status: "error",
    auth: { status: "unauthenticated" },
    ...overrides,
  });
}

/** A provider that reports limits but no windows, and no `unavailable` reason. */
export function emptyWindowsProvider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return makeProvider({
    instanceId: "empty",
    usageLimits: { checkedAt: CHECKED_AT, windows: [] },
    ...overrides,
  });
}
