/**
 * Typed method maps. Only the methods plugins need first are typed (wire/JSON shapes, i.e. the
 * schemas' `Encoded` side, from @t3p/contracts-vendor); every other method falls back to `unknown`
 * through the index signature, so `client.call("anything", {})` still typechecks.
 *
 * Keys are the wire tags in docs/spikes/wp-0d/fixtures/methods.json (also dist/methods.json of
 * @t3p/contracts-vendor).
 */
import type {
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2Command,
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2GetOlderSettledThreadsInput,
  OrchestrationV2GetThreadFamilyInput,
  OrchestrationV2GetThreadProjectionInput,
  OrchestrationV2GetThreadTitlesInput,
  OrchestrationV2OlderSettledThreadsPage,
  OrchestrationV2SearchThreadsInput,
  OrchestrationV2SearchThreadsResult,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadFamily,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItemShape,
  OrchestrationV2ThreadTitles,
  ProjectEnsureScratchResult,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerProviderUpdatedPayload,
} from "@t3p/contracts-vendor";

/** Wire (JSON) shape of a schema value. */
type Wire<S> = S extends { readonly Encoded: infer E } ? E : never;

/** Payload of `subscribeServerConfig` (flags are all optional; see contracts `WsSubscribeServerConfigRpc`). */
export interface SubscribeServerConfigPayload {
  environmentThemes?: boolean;
  usageLimitSources?: boolean;
  usageLimitsCommand?: boolean;
  workspaceSnapshotsOnDemand?: boolean;
  providerCatalogsOnDemand?: boolean;
  providerCatalogDigests?: boolean;
  providerStatusDeltas?: boolean;
}

/** Payload of `server.refreshProviders` (see contracts `WsServerRefreshProvidersRpc`; all optional). */
export interface RefreshProvidersPayload {
  instanceId?: string;
  cwd?: string;
  fresh?: boolean;
  refreshModels?: boolean;
  modelCatalogOnly?: boolean;
  reloadSecrets?: boolean;
  workspaceSnapshotsOnDemand?: boolean;
  usageLimitsCommand?: boolean;
  providerCatalogsOnDemand?: boolean;
  omitProviders?: boolean;
  machineCatalog?: boolean;
}

export type ThreadStreamItem = OrchestrationV2ThreadStreamItemShape;
export type ThreadSnapshotItem = Extract<ThreadStreamItem, { kind: "snapshot" }>;
export type ThreadEventItem = Extract<ThreadStreamItem, { kind: "event" }>;

interface UnaryMethods {
  "server.getConfig": { payload: Record<string, never>; result: Wire<typeof ServerConfig> };
  "server.refreshProviders": { payload: RefreshProvidersPayload; result: Wire<typeof ServerProviderUpdatedPayload> };
  "projects.ensureScratch": { payload: Record<string, never>; result: Wire<typeof ProjectEnsureScratchResult> };
  "orchestration.dispatchCommand": {
    payload: Wire<typeof OrchestrationV2Command>;
    result: Wire<typeof OrchestrationV2DispatchCommandResult>;
  };
  "orchestration.getThreadProjection": {
    payload: Wire<typeof OrchestrationV2GetThreadProjectionInput>;
    result: Wire<typeof OrchestrationV2ThreadProjection>;
  };
  "orchestration.getThreadTitles": {
    payload: Wire<typeof OrchestrationV2GetThreadTitlesInput>;
    result: Wire<typeof OrchestrationV2ThreadTitles>;
  };
  "orchestration.getThreadFamily": {
    payload: Wire<typeof OrchestrationV2GetThreadFamilyInput>;
    result: Wire<typeof OrchestrationV2ThreadFamily>;
  };
  "orchestration.getArchivedShellSnapshot": {
    payload: Record<string, never>;
    result: Wire<typeof OrchestrationV2ArchivedShellSnapshot>;
  };
  "orchestration.getOlderSettledThreads": {
    payload: Wire<typeof OrchestrationV2GetOlderSettledThreadsInput>;
    result: Wire<typeof OrchestrationV2OlderSettledThreadsPage>;
  };
  "orchestration.searchThreads": {
    payload: Wire<typeof OrchestrationV2SearchThreadsInput>;
    result: Wire<typeof OrchestrationV2SearchThreadsResult>;
  };
}

interface StreamMethods {
  subscribeServerConfig: { payload: SubscribeServerConfigPayload; item: Wire<typeof ServerConfigStreamEvent> };
  "orchestration.subscribeThread": { payload: Wire<typeof OrchestrationV2SubscribeThreadInput>; item: ThreadStreamItem };
  "orchestration.subscribeShell": {
    payload: Wire<typeof OrchestrationV2SubscribeShellInput>;
    item: Wire<typeof OrchestrationV2ShellStreamItem>;
  };
}

/** Unary methods. Unknown methods: payload and result are `unknown`. */
export interface RpcMethods extends UnaryMethods {
  [method: string]: { payload: unknown; result: unknown };
}

/** Stream methods (one `Chunk` value per item). Unknown methods: payload and item are `unknown`. */
export interface RpcStreams extends StreamMethods {
  [method: string]: { payload: unknown; item: unknown };
}
