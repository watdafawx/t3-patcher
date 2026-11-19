import type { LimitsView, ModelView, ProviderView } from "../src/logic/types.js";

/** A provider instance with sensible defaults; override only what a test is about. */
export function provider(overrides: Partial<ProviderView> & { instanceId: string }): ProviderView {
  return {
    instanceId: overrides.instanceId,
    installed: true,
    enabled: true,
    status: "ready",
    models: [{ slug: "model-a", name: "Model A" }],
    ...overrides,
  };
}

export function model(slug: string, overrides: Partial<ModelView> = {}): ModelView {
  return { slug, name: slug.toUpperCase(), ...overrides };
}

export function limits(
  windows: Array<{ id: string; usedPercent: number; label?: string; kind?: string }>,
  overrides: Partial<LimitsView> = {},
): LimitsView {
  return {
    windows: windows.map((window) => ({
      id: window.id,
      kind: window.kind ?? "session",
      label: window.label ?? window.id,
      usedPercent: window.usedPercent,
    })),
    ...overrides,
  };
}
