/**
 * Errors thrown by the `t3` API. Every one carries a stable string `code`. Match on `code` (or use
 * {@link isT3Error}), NOT on `instanceof`: a plugin that bundles `@t3p/api` gets its own copy of these
 * classes, so `instanceof` against the runtime's instances is false. `code` values are part of the API.
 */

export type T3ErrorCode = "not-implemented" | "permission" | "quota";

/** Structural form of every error the API throws. */
export interface T3ErrorLike extends Error {
  readonly code: T3ErrorCode;
}

/** True when `error` is an API error, optionally of one `code`. Works across bundled copies of this package. */
export function isT3Error(error: unknown, code?: T3ErrorCode): error is T3ErrorLike {
  if (typeof error !== "object" || error === null) return false;
  const c = (error as { code?: unknown }).code;
  const known = c === "not-implemented" || c === "permission" || c === "quota";
  return known && (code === undefined || c === code) && (error as { name?: unknown }).name?.toString().startsWith("T3") === true;
}

/** Names the work package that owns a `t3` namespace whose implementation has not landed yet. */
export class T3NotImplementedError extends Error {
  override readonly name = "T3NotImplementedError";
  readonly code = "not-implemented" as const;
  /** Namespace path, e.g. `"providers.list"`. */
  readonly api: string;
  /** Owning work package, e.g. `"WP-3B"`. */
  readonly owner: string;

  constructor(api: string, owner: string) {
    super(`t3.${api} is not implemented yet (owner ${owner})`);
    this.api = api;
    this.owner = owner;
  }
}

/** A `t3` call needs a permission the plugin did not declare in plugin.json or the user has not granted. */
export class T3PermissionError extends Error {
  override readonly name = "T3PermissionError";
  readonly code = "permission" as const;
  /** The plugin that made the call. */
  readonly plugin: string;
  /** The missing permission, e.g. `"rpc"` or `"fs.read"`. */
  readonly permission: string;

  constructor(plugin: string, permission: string, detail?: string) {
    super(`plugin ${plugin} needs permission "${permission}"${detail ? `: ${detail}` : ""}`);
    this.plugin = plugin;
    this.permission = permission;
  }
}

/** A plugin exceeded its `t3.storage` quota. */
export class T3QuotaError extends Error {
  override readonly name = "T3QuotaError";
  readonly code = "quota" as const;
  readonly plugin: string;
  readonly limitBytes: number;

  constructor(plugin: string, limitBytes: number) {
    super(`plugin ${plugin} storage quota of ${limitBytes} bytes exceeded`);
    this.plugin = plugin;
    this.limitBytes = limitBytes;
  }
}
