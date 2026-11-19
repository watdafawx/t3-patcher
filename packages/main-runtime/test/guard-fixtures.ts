/**
 * A miniature server chunk shaped like upstream's `apps/server/dist/runtimeLayer-<hash>.mjs`
 * (v0.1.10 line 97425 / nightly 91285), plus a tiny Effect stand-in that runs the generator, so
 * the patched code is executed for real.
 */

export const CHUNK_IMPORT = `import { n as fnUntraced, Fs as tryPromise, Tg as TaggedError$1 } from "./effect.mjs";\n`;

export const CHUNK_BODY = `var OrchestratorDispatchError = class extends TaggedError$1()("OrchestratorDispatchError", {}) {};
const dispatchWithReceipt = fnUntraced(function* (command) {
	const receipt = { sequence: 1, command };
	return receipt;
});
export { dispatchWithReceipt };
`;

export const CHUNK = CHUNK_IMPORT + CHUNK_BODY;

/** ESM source of `effect.mjs` for the integration test (same semantics as {@link effectStandIn}). */
export const EFFECT_MODULE = `
export const n = (gen) => (...args) => {
  const it = gen(...args);
  const step = async (input) => {
    const r = it.next(input);
    if (r.done) return r.value;
    const eff = r.value;
    let value;
    try { value = await eff.try(); } catch (cause) { throw eff.catch(cause); }
    return step(value);
  };
  return step(undefined);
};
export const Fs = (o) => ({ *[Symbol.iterator]() { return yield o; } });
export const Tg = () => (tag) => class extends Error {
  constructor(fields) { super(String(fields.cause)); Object.assign(this, fields); this._tag = tag; }
};
`;

type Dispatch = (command: unknown) => Promise<{ sequence: number; command: Record<string, unknown> }>;

/** Evaluates a (patched) chunk without its import line, against the stand-in. */
export function loadChunk(code: string): Dispatch {
  const body = code.replace(CHUNK_IMPORT, "").replace("export { dispatchWithReceipt };", "return dispatchWithReceipt;");
  const n =
    (gen: (...a: unknown[]) => Generator<{ try(): Promise<unknown>; catch(e: unknown): unknown }, unknown, unknown>) =>
    (...args: unknown[]) => {
      const it = gen(...args);
      const step = async (input: unknown): Promise<unknown> => {
        const r = it.next(input);
        if (r.done) return r.value;
        const eff = r.value;
        let value: unknown;
        try {
          value = await eff.try();
        } catch (cause) {
          throw eff.catch(cause);
        }
        return step(value);
      };
      return step(undefined);
    };
  const Fs = (o: unknown) => ({
    *[Symbol.iterator]() {
      return yield o;
    },
  });
  const Tg = () => (tag: string) =>
    class extends Error {
      _tag = tag;
      constructor(fields: Record<string, unknown>) {
        super(String(fields.cause));
        Object.assign(this, fields);
      }
    };
  return new Function("fnUntraced", "tryPromise", "TaggedError$1", body)(n, Fs, Tg) as Dispatch;
}
