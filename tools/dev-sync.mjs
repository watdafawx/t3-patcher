// Copies packages/main-runtime/dist into ~/.t3-patcher/runtime so a Ctrl+R in T3 Code picks up core
// renderer changes. `--watch` re-copies after every rebuild. Main/preload changes still need an app restart.
import { cpSync, existsSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const src = resolve(import.meta.dirname, "..", "packages", "main-runtime", "dist");
const dst = join(process.env.T3P_HOME ?? homedir(), ".t3-patcher", "runtime");
const sync = () => {
  if (!existsSync(src)) return console.error(`no build at ${src}`);
  cpSync(src, dst, { recursive: true, force: true });
  console.log(`synced ${src} -> ${dst} ${new Date().toLocaleTimeString()}`);
};
sync();
if (process.argv.includes("--watch")) {
  let t;
  watch(src, () => {
    clearTimeout(t);
    t = setTimeout(sync, 300);
  });
  console.log("watching; rebuild with `pnpm --filter @t3p/renderer-runtime build` then main-runtime");
}
