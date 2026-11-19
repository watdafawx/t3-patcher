// Renderer-only plugin that throws in start(): the bootstrap must log it and keep loading the others.
export function start() {
  throw new Error("throw-renderer: start exploded on purpose");
}
