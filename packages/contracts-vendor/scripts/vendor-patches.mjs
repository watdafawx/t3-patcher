// Source patches applied to the COPY of upstream contracts (dist/.src/src) before declaration emit.
// Needed because tsc cannot serialise a few giant inferred schema types (TS7056).
// Each patch must match exactly once or the build fails, so an upstream bump that moves the
// code is noticed immediately. Only the emitted .d.ts is shipped; runtime behaviour of the copy is irrelevant.

/** Modules dropped from the vendor entirely (their giant HttpApi class cannot be declared; plugins never need it). */
export const excludeModules = ["environmentHttp.ts"];

export const patches = [
  {
    // The one that matters: the thread stream item. Give it an explicit, hand-written decoded type
    // (built from the named upstream types) instead of the inferred one.
    file: "orchestrationV2.ts",
    find: "export const OrchestrationV2ThreadStreamItem = withRecordIdTable(\n",
    replace: `/** Wire (JSON) shape of a thread stream item for a client that omits the accept* flags (no idTable). */
export type OrchestrationV2ThreadStreamItemShape =
  | { readonly kind: "synchronized" }
  | {
      readonly kind: "snapshot";
      readonly snapshotSequence: number;
      readonly projection: (typeof OrchestrationV2ThreadProjection)["Encoded"];
      readonly historyCursor?: string | null;
      readonly hasMoreHistory?: boolean;
      readonly latestLocalTurnOrdinal?: number | null;
      readonly turnItemsOmitLocalVisible?: true;
    }
  | { readonly kind: "event"; readonly sequence: number; readonly event: (typeof OrchestrationV2DomainEvent)["Encoded"] };
export const OrchestrationV2ThreadStreamItem: Schema.Codec<OrchestrationV2ThreadStreamItemShape, OrchestrationV2ThreadStreamItemShape> = withRecordIdTable(
`,
  },
  {
    file: "orchestrationV2.ts",
    find: "  (item) => (item.kind === \"snapshot\" ? \"projection\" : undefined),\n);\nexport type OrchestrationV2ThreadStreamItem",
    replace:
      "  (item) => (item.kind === \"snapshot\" ? \"projection\" : undefined),\n) as never;\nexport type OrchestrationV2ThreadStreamItem",
  },
  {
    // Server-side RPC schema bundle; not needed by plugins.
    file: "orchestrationV2.ts",
    find: "export const OrchestrationV2RpcSchemas = {",
    replace: "export const OrchestrationV2RpcSchemas: any = {",
  },
  {
    // Group of 221 Rpc.make; method typing comes from our own map in rpc-client.
    file: "rpc.ts",
    find: "export const WsRpcGroup = RpcGroup.make(",
    replace: "export const WsRpcGroup: any = RpcGroup.make(",
  },
];
