/**
 * Tiny hand-written validators for IPC payloads. Unknown object keys are
 * rejected, so a renderer cannot smuggle options a handler does not expect.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type Validator<T> = (value: unknown, where: string) => Result<T>;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

export const s = {
  string(opts: { max?: number; min?: number; pattern?: RegExp } = {}): Validator<string> {
    return (v, where) => {
      if (typeof v !== "string") return fail(`${where} must be a string`);
      if (v.length < (opts.min ?? 0)) return fail(`${where} is too short`);
      if (v.length > (opts.max ?? 65_536)) return fail(`${where} is too long`);
      if (opts.pattern && !opts.pattern.test(v)) return fail(`${where} has an invalid format`);
      return ok(v);
    };
  },
  int(opts: { min?: number; max?: number } = {}): Validator<number> {
    return (v, where) => {
      if (typeof v !== "number" || !Number.isSafeInteger(v)) return fail(`${where} must be an integer`);
      if (opts.min !== undefined && v < opts.min) return fail(`${where} must be >= ${opts.min}`);
      if (opts.max !== undefined && v > opts.max) return fail(`${where} must be <= ${opts.max}`);
      return ok(v);
    };
  },
  boolean(): Validator<boolean> {
    return (v, where) => (typeof v === "boolean" ? ok(v) : fail(`${where} must be a boolean`));
  },
  literal<T extends string>(...values: T[]): Validator<T> {
    return (v, where) => ((values as unknown[]).includes(v) ? ok(v as T) : fail(`${where} must be one of ${values.join(", ")}`));
  },
  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (v, where) => (v === undefined ? ok(undefined) : inner(v, where));
  },
  array<T>(inner: Validator<T>, opts: { max?: number } = {}): Validator<T[]> {
    return (v, where) => {
      if (!Array.isArray(v)) return fail(`${where} must be an array`);
      if (v.length > (opts.max ?? 1000)) return fail(`${where} has too many items`);
      const out: T[] = [];
      for (let i = 0; i < v.length; i++) {
        const r = inner(v[i], `${where}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    };
  },
  union<A, B>(a: Validator<A>, b: Validator<B>): Validator<A | B> {
    return (v, where) => {
      const ra = a(v, where);
      return ra.ok ? ra : b(v, where);
    };
  },
  nullValue(): Validator<null> {
    return (v, where) => (v === null ? ok(null) : fail(`${where} must be null`));
  },
  number(): Validator<number> {
    return (v, where) => (typeof v === "number" && Number.isFinite(v) ? ok(v) : fail(`${where} must be a finite number`));
  },
  object<T extends Record<string, unknown>>(shape: { [K in keyof T]: Validator<T[K]> }): Validator<T> {
    return (v, where) => {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(`${where} must be an object`);
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return fail(`${where} must be a plain object`);
      const input = v as Record<string, unknown>;
      for (const key of Object.keys(input)) if (!Object.hasOwn(shape, key)) return fail(`${where}.${key} is not allowed`);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const r = (shape as Record<string, Validator<unknown>>)[key]!(input[key], `${where}.${key}`);
        if (!r.ok) return r;
        if (r.value !== undefined) out[key] = r.value;
      }
      return ok(out as T);
    };
  },
  /** Any JSON-like value up to a serialized size (plugin channels; the plugin validates the shape). */
  json(opts: { maxBytes?: number } = {}): Validator<unknown> {
    return (v, where) => {
      let text: string | undefined;
      try {
        text = JSON.stringify(v);
      } catch {
        return fail(`${where} must be JSON-serializable`);
      }
      if (text !== undefined && text.length > (opts.maxBytes ?? 1_000_000)) return fail(`${where} is too large`);
      return ok(v);
    };
  },
  none(): Validator<undefined> {
    return (v, where) => (v === undefined || v === null ? ok(undefined) : fail(`${where} must be empty`));
  },
};
