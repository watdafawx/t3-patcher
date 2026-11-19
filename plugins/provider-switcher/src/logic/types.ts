/**
 * Structural views of the values this plugin reads from the public API.
 *
 * The wire shapes behind them are owned by upstream (`ServerProvider`, the thread projection), so
 * they are mapped in `map.ts` instead of being spread through the logic modules. That keeps the pure
 * logic testable with small synthetic fixtures.
 */

/** One model of a provider instance. */
export interface ModelView {
  slug: string;
  name: string;
  supportsTextGeneration?: boolean;
  isDefault?: boolean;
}

/** One usage-limit window. */
export interface LimitWindowView {
  id: string;
  kind: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  modelIds?: string[];
}

/** Usage limits of one provider instance. */
export interface LimitsView {
  windows: LimitWindowView[];
  unavailable?: { reason: string; message?: string };
}

/** The parts of a provider instance this plugin uses. */
export interface ProviderView {
  instanceId: string;
  displayName?: string;
  installed: boolean;
  enabled: boolean;
  /** `ready` | `warning` | `error` | `disabled` (upstream enum). */
  status: string;
  /** `available` | `unavailable`, when reported. */
  availability?: string;
  unavailableReason?: string;
  /** Provider message, e.g. why it is in `error`. */
  message?: string;
  authStatus?: string;
  models: ModelView[];
  usageLimits?: LimitsView;
}

/** A model selection: provider instance plus model id. */
export interface Selection {
  providerInstanceId: string;
  model: string;
}

/** Which API call applies to a selection: same provider is a model switch, another provider is a provider switch. */
export type SwitchKind = "model" | "provider";

/** One run of a thread, as the projection and the `run.*` events report it. */
export interface RunView {
  id: string;
  status: string;
}

/** The parts of a thread projection this plugin reads. */
export interface ProjectionView {
  runs: RunView[];
  modelSelection: Selection | null;
}
