export type RpcErrorKind = "failure" | "defect" | "interrupted" | "closed" | "http";

const MAX_MESSAGE = 1000;
const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}...<${s.length - MAX_MESSAGE} more chars>` : s);

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  /** `_tag` of the typed server error (kind "failure"), or of the HTTP error body (kind "http"). */
  readonly tag?: string;
  /** Raw `cause` array of `Exit.Failure` (kind failure/defect/interrupted). */
  readonly cause?: unknown;
  /** HTTP status (kind "http"). */
  readonly status?: number;

  constructor(kind: RpcErrorKind, message: string, extra: { tag?: string; cause?: unknown; status?: number } = {}) {
    super(clip(message));
    this.name = "RpcError";
    this.kind = kind;
    if (extra.tag !== undefined) this.tag = extra.tag;
    if (extra.cause !== undefined) this.cause = extra.cause;
    if (extra.status !== undefined) this.status = extra.status;
  }

  /**
   * For `OrchestrationV2DispatchCommandError`: the inner `cause.name`, e.g.
   * `"OrchestratorProviderSelectionBusyError"`. The outer `tag` is the same for every dispatch error.
   */
  get causeName(): string | undefined {
    return rpcErrorCauseName(this);
  }

  /** True when a provider switch was refused because a run is active. */
  get isProviderSelectionBusy(): boolean {
    return this.causeName === "OrchestratorProviderSelectionBusyError";
  }
}

export function rpcErrorCauseName(err: RpcError): string | undefined {
  if (!Array.isArray(err.cause)) return undefined;
  for (const c of err.cause as unknown[]) {
    const inner = (c as { error?: { cause?: { name?: unknown } } } | null)?.error?.cause?.name;
    if (typeof inner === "string") return inner;
  }
  return undefined;
}

/** Build an RpcError from `Exit.Failure.cause` (array of `Fail` / `Die` / `Interrupt`). */
export function errorFromCause(cause: unknown, method?: string): RpcError {
  const list = Array.isArray(cause) ? (cause as Array<Record<string, unknown>>) : [];
  const fail = list.find((c) => c?._tag === "Fail");
  if (fail) {
    const e = (fail.error ?? {}) as { _tag?: unknown; message?: unknown };
    const tag = typeof e._tag === "string" ? e._tag : undefined;
    const msg = typeof e.message === "string" ? e.message : JSON.stringify(fail.error);
    return new RpcError("failure", `${tag ?? "Failure"}${method ? ` (${method})` : ""}: ${msg}`, { ...(tag ? { tag } : {}), cause });
  }
  const die = list.find((c) => c?._tag === "Die");
  if (die) {
    const d = die.defect;
    return new RpcError("defect", `${method ? `${method}: ` : ""}${typeof d === "string" ? d : JSON.stringify(d)}`, { cause });
  }
  if (list.some((c) => c?._tag === "Interrupt")) {
    return new RpcError("interrupted", `${method ?? "request"} interrupted`, { cause });
  }
  return new RpcError("defect", `${method ?? "request"} failed with an unrecognised cause: ${JSON.stringify(cause)}`, { cause });
}
