import type { ProviderSnapshot, ThreadProjection } from "@t3p/api";

import { selectionFromProjection } from "./logic/grouping.js";
import type { LimitsView, ModelView, ProjectionView, ProviderView, RunView } from "./logic/types.js";

/**
 * Wire to view mapping for the two upstream shapes this plugin reads. Everything else in the plugin
 * works on the small views in `logic/types.ts`; a change to the wire shape shows up here only.
 */

function modelView(model: ProviderSnapshot["models"][number]): ModelView {
  return {
    slug: model.slug,
    name: model.name,
    ...(model.supportsTextGeneration === undefined ? {} : { supportsTextGeneration: model.supportsTextGeneration }),
    ...(model.isDefault === undefined ? {} : { isDefault: model.isDefault }),
  };
}

function limitsView(limits: NonNullable<ProviderSnapshot["usageLimits"]>): LimitsView {
  return {
    windows: (limits.windows ?? []).map((window) => ({
      id: window.id,
      kind: window.kind,
      label: window.label,
      usedPercent: window.usedPercent,
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      ...(window.modelIds === undefined ? {} : { modelIds: [...window.modelIds] }),
    })),
    ...(limits.unavailable === undefined
      ? {}
      : { unavailable: { reason: limits.unavailable.reason, ...(limits.unavailable.message ? { message: limits.unavailable.message } : {}) } }),
  };
}

/** The provider list as the menu and the suggestion rule see it. */
export function providerView(provider: ProviderSnapshot): ProviderView {
  return {
    instanceId: provider.instanceId,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    installed: provider.installed,
    enabled: provider.enabled,
    status: provider.status,
    ...(provider.availability === undefined ? {} : { availability: provider.availability }),
    ...(provider.unavailableReason === undefined ? {} : { unavailableReason: provider.unavailableReason }),
    ...(provider.message === undefined ? {} : { message: provider.message }),
    ...(provider.auth?.status === undefined ? {} : { authStatus: provider.auth.status }),
    models: (provider.models ?? []).map(modelView),
    ...(provider.usageLimits === undefined ? {} : { usageLimits: limitsView(provider.usageLimits) }),
  };
}

export function providerViews(providers: readonly ProviderSnapshot[]): ProviderView[] {
  return providers.map(providerView);
}

function runView(run: ThreadProjection["runs"][number]): RunView {
  return { id: run.id, status: run.status };
}

/** The thread projection as the idle tracker sees it. */
export function projectionView(projection: ThreadProjection): ProjectionView {
  return {
    runs: (projection.runs ?? []).map(runView),
    modelSelection: selectionFromProjection(projection.thread?.modelSelection),
  };
}
