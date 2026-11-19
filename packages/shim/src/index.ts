// The replacement resources/app.asar entry, exactly as it is written into the
// installer's asar: read `src/shim.cjs` and embed those bytes at build time.
export { SHIM_SOURCE } from "./shim-source.generated.js";
