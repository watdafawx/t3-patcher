import { describe, expect, it } from "vitest";

import {
  buildModelGroups,
  pickDefaultModel,
  providerUsability,
  selectionFromProjection,
  switchKindFor,
} from "../src/logic/grouping.js";
import { limits, model, provider } from "./fixtures.js";

describe("providerUsability", () => {
  it("accepts installed providers that are ready or warning", () => {
    expect(providerUsability(provider({ instanceId: "a" }))).toEqual({ usable: true, reason: null });
    expect(providerUsability(provider({ instanceId: "a", status: "warning" })).usable).toBe(true);
  });

  it("explains every unusable state", () => {
    expect(providerUsability(provider({ instanceId: "a", installed: false }))).toEqual({ usable: false, reason: "not installed" });
    expect(providerUsability(provider({ instanceId: "a", enabled: false }))).toEqual({ usable: false, reason: "disabled" });
    expect(providerUsability(provider({ instanceId: "a", status: "disabled" }))).toEqual({ usable: false, reason: "disabled" });
    expect(providerUsability(provider({ instanceId: "a", status: "error", message: "token expired" }))).toEqual({
      usable: false,
      reason: "token expired",
    });
    expect(providerUsability(provider({ instanceId: "a", status: "error", authStatus: "unauthenticated" }))).toEqual({
      usable: false,
      reason: "not signed in",
    });
    expect(providerUsability(provider({ instanceId: "a", status: "error", authStatus: "unknown" }))).toEqual({
      usable: false,
      reason: "error",
    });
    expect(
      providerUsability(provider({ instanceId: "a", availability: "unavailable", unavailableReason: "binary missing" })),
    ).toEqual({ usable: false, reason: "binary missing" });
    expect(providerUsability(provider({ instanceId: "a", availability: "unavailable" }))).toEqual({
      usable: false,
      reason: "unavailable",
    });
  });
});

describe("buildModelGroups", () => {
  const current = { providerInstanceId: "b", model: "b-2" };
  const providers = [
    provider({ instanceId: "c", displayName: "Charlie", models: [model("c-1"), model("c-2")] }),
    provider({ instanceId: "a", displayName: "Alpha", status: "error", message: "signed out", models: [model("a-1")] }),
    provider({ instanceId: "b", displayName: "Bravo", models: [model("b-1"), model("b-2"), model("b-3")] }),
    provider({ instanceId: "d", models: [model("d-1"), model("d-2", { supportsTextGeneration: false })] }),
  ];

  it("puts the current provider first, then usable ones, then unusable ones", () => {
    expect(buildModelGroups(providers, current).map((group) => group.providerInstanceId)).toEqual(["b", "c", "d", "a"]);
  });

  it("marks the current model and moves it to the top of its group", () => {
    const group = buildModelGroups(providers, current).find((candidate) => candidate.providerInstanceId === "b");
    expect(group?.models.map((option) => option.model)).toEqual(["b-2", "b-1", "b-3"]);
    expect(group?.models[0].current).toBe(true);
    expect(group?.models[1].current).toBe(false);
  });

  it("keeps unusable providers listed with their models disabled and the reason attached", () => {
    const group = buildModelGroups(providers, current).find((candidate) => candidate.providerInstanceId === "a");
    expect(group?.usable).toBe(false);
    expect(group?.reason).toBe("signed out");
    expect(group?.models).toEqual([
      {
        providerInstanceId: "a",
        providerLabel: "Alpha",
        model: "a-1",
        label: "A-1",
        usable: false,
        reason: "signed out",
        current: false,
      },
    ]);
  });

  it("drops models that cannot answer a text turn", () => {
    const group = buildModelGroups(providers, current).find((candidate) => candidate.providerInstanceId === "d");
    expect(group?.models.map((option) => option.model)).toEqual(["d-1"]);
  });

  it("falls back to the instance id for a group label and keeps empty groups", () => {
    const groups = buildModelGroups(
      [provider({ instanceId: "solo", models: [model("s", { supportsTextGeneration: false })] })],
      null,
    );
    expect(groups[0].label).toBe("solo");
    expect(groups[0].models).toEqual([]);
  });
});

describe("switchKindFor", () => {
  it("uses setModel within the same provider and switchProvider across providers", () => {
    expect(switchKindFor("claudeAgent", { providerInstanceId: "claudeAgent", model: "x" })).toBe("model");
    expect(switchKindFor("claudeAgent", { providerInstanceId: "codex", model: "x" })).toBe("provider");
    expect(switchKindFor(null, { providerInstanceId: "claudeAgent", model: "x" })).toBe("provider");
  });
});

describe("pickDefaultModel", () => {
  it("prefers the default model, then the first text model", () => {
    const explicit = provider({
      instanceId: "a",
      models: [model("one"), model("two", { isDefault: true })],
    });
    expect(pickDefaultModel(explicit)?.slug).toBe("two");
    const implicit = provider({ instanceId: "b", models: [model("skip", { supportsTextGeneration: false }), model("three")] });
    expect(pickDefaultModel(implicit)?.slug).toBe("three");
    expect(pickDefaultModel(provider({ instanceId: "c", models: [] }))).toBeNull();
  });
});

describe("selectionFromProjection", () => {
  it("reads the wire modelSelection and rejects anything else", () => {
    expect(selectionFromProjection({ instanceId: "claudeAgent", model: "opus" })).toEqual({
      providerInstanceId: "claudeAgent",
      model: "opus",
    });
    expect(selectionFromProjection({ instanceId: "a" })).toBeNull();
    expect(selectionFromProjection(null)).toBeNull();
    expect(selectionFromProjection("nope")).toBeNull();
  });
});

describe("provider usage limits in a group", () => {
  it("does not let limits change usability", () => {
    const withLimits = provider({ instanceId: "a", usageLimits: limits([{ id: "weekly", usedPercent: 100 }]) });
    expect(providerUsability(withLimits).usable).toBe(true);
  });
});
