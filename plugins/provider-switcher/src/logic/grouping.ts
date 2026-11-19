import type { ModelView, ProviderView, Selection, SwitchKind } from "./types.js";

/**
 * Whether a provider instance can run a turn, and a short reason when it cannot.
 *
 * The API (`t3.threads.switchProvider`) applies the same rule before it sends anything: installed,
 * not disabled, and `status` in `ready|warning`. Availability is checked too: a provider that
 * reports itself unavailable cannot be selected either. The reason string is user-facing.
 */
export function providerUsability(provider: ProviderView): { usable: boolean; reason: string | null } {
  if (!provider.installed) return { usable: false, reason: "not installed" };
  if (provider.enabled === false) return { usable: false, reason: "disabled" };
  if (provider.availability === "unavailable") {
    return { usable: false, reason: provider.unavailableReason?.trim() || "unavailable" };
  }
  if (provider.status === "disabled") return { usable: false, reason: "disabled" };
  if (provider.status === "error") {
    const reason = provider.message?.trim();
    if (reason) return { usable: false, reason };
    return { usable: false, reason: provider.authStatus === "unauthenticated" ? "not signed in" : "error" };
  }
  if (provider.status !== "ready" && provider.status !== "warning") {
    return { usable: false, reason: provider.message?.trim() || `status ${provider.status}` };
  }
  return { usable: true, reason: null };
}

/** One selectable row of the menu. */
export interface ModelOption {
  providerInstanceId: string;
  providerLabel: string;
  model: string;
  /** Display name from the provider, falling back to the model id. */
  label: string;
  /** The provider can run a turn (an option of an unusable provider is disabled). */
  usable: boolean;
  reason: string | null;
  /** This is the thread's current provider and model. */
  current: boolean;
}

/** One provider group of the menu. */
export interface ModelGroup {
  providerInstanceId: string;
  label: string;
  usable: boolean;
  reason: string | null;
  models: ModelOption[];
}

const labelOf = (provider: ProviderView): string => provider.displayName?.trim() || provider.instanceId;

/** Models that can answer a text turn, in provider order. */
function textModels(provider: ProviderView): ModelView[] {
  return provider.models.filter((model) => model.supportsTextGeneration !== false);
}

/**
 * The menu model: one group per provider instance, every model (with `supportsTextGeneration: false`
 * filtered out), the current model first in its own group.
 *
 * Order: the current provider, then usable providers, then unusable ones; alphabetical by label
 * inside each bucket. Unusable providers stay listed (and their models disabled) so the reason is
 * visible; the UI never hides a provider silently.
 */
export function buildModelGroups(providers: readonly ProviderView[], current: Selection | null): ModelGroup[] {
  const groups: ModelGroup[] = providers.map((provider) => {
    const { usable, reason } = providerUsability(provider);
    const label = labelOf(provider);
    const models = textModels(provider).map(
      (model): ModelOption => ({
        providerInstanceId: provider.instanceId,
        providerLabel: label,
        model: model.slug,
        label: model.name?.trim() || model.slug,
        usable,
        reason,
        current: current !== null && current.providerInstanceId === provider.instanceId && current.model === model.slug,
      }),
    );
    if (models.length > 1) {
      const index = models.findIndex((option) => option.current);
      if (index > 0) models.unshift(...models.splice(index, 1));
    }
    return { providerInstanceId: provider.instanceId, label, usable, reason, models };
  });

  const bucket = (group: ModelGroup): number => {
    if (current !== null && group.providerInstanceId === current.providerInstanceId) return 0;
    return group.usable ? 1 : 2;
  };
  const byLabel = (a: ModelGroup, b: ModelGroup): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.providerInstanceId < b.providerInstanceId ? -1 : 1);
  return groups.sort((a, b) => bucket(a) - bucket(b) || byLabel(a, b));
}

/** `setModel` keeps the provider, `switchProvider` moves it. */
export function switchKindFor(currentProviderInstanceId: string | null, selection: Selection): SwitchKind {
  return currentProviderInstanceId !== null && selection.providerInstanceId === currentProviderInstanceId ? "model" : "provider";
}

/** The model a provider would start with: its default, else the first text model. */
export function pickDefaultModel(provider: ProviderView): ModelView | null {
  const models = textModels(provider);
  return models.find((model) => model.isDefault === true) ?? models[0] ?? null;
}

/** The thread's current selection from the wire `modelSelection`. */
export function selectionFromProjection(modelSelection: unknown): Selection | null {
  if (modelSelection !== null && typeof modelSelection === "object") {
    const record = modelSelection as { instanceId?: unknown; model?: unknown };
    if (typeof record.instanceId === "string" && typeof record.model === "string") {
      return { providerInstanceId: record.instanceId, model: record.model };
    }
  }
  return null;
}
