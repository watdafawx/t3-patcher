import { CAPTURE_NAMES, type CaptureName } from "@t3p/api";
import type { Patch } from "@t3p/patch-engine";

import { CORE_OWNER } from "./builtin.js";

/**
 * Tier 2 captures: first-party patches that hand app singletons to the renderer runtime
 * (`window.__t3p_plugins["t3p.core"]`, see packages/renderer-runtime/src/core.ts).
 *
 * One capture = one logical patch. The settings page needs edits in several chunks, so a capture
 * owns a list of {@link Patch}es; its status is the worst status of its patches.
 *
 * Written against the T3 Code 0.1.10 client. Identifiers are minified and change per release, so
 * every pattern anchors on the shape of the code (property names, string literals), never on a
 * minified name. `find` is the text that must occur in exactly one chunk.
 *
 * The matching tests run these patches against the real client: `T3P_CLIENT_DIR=<dir> pnpm --filter
 * @t3p/main-runtime test` (skipped when the directory is not given).
 */
export { CAPTURE_NAMES, type CaptureName };

export interface CaptureDef {
  name: CaptureName;
  /** What the capture hands to plugins, for the status file and the docs. */
  summary: string;
  patches: Patch[];
}

const self = (patch: Omit<Patch, "plugin">): Patch => ({ plugin: CORE_OWNER, ...patch });

/** `appAtomRegistry = AtomRegistry.make()` followed by its React provider and `subscribeAtomChanges` (rpc/atomRegistry.ts). */
const ATOM_REGISTRY = /([\w$]+)=([\w$]+)\(\)(;function [\w$]+\(\{children:[\w$]+\}\)\{return\(0,([\w$]+)\.createElement\)\([\w$]+\.Provider,\{value:\1\},[\w$]+\)\}function [\w$]+\([\w$]+,[\w$]+\)\{let [\w$]+=!0;return \1\.subscribe\()/;

/** `createRouter({ routeTree, history, context: {}, defaultPreload: "intent" })` (router.ts). */
const ROUTER = /return ([\w$]+)\(\{routeTree:([\w$]+),history:([\w$]+),context:\{\},defaultPreload:`intent`\}\)/;

/** `registerCommands` (shortcuts/dispatcher.ts): `function x(e,t={}){return b(t.observe?l:t.capture?c:s,{commands:e,options:t})}`. */
const DISPATCHER = /function ([\w$]+)\(([\w$]+),([\w$]+)=\{\}\)\{return ([\w$]+)\(\3\.observe\?([\w$]+):\3\.capture\?([\w$]+):([\w$]+),\{commands:\2,options:\3\}\)\}/;

export const CAPTURES: CaptureDef[] = [
  {
    name: "atomRegistry",
    summary: "app atom registry (effect-atom AtomRegistry); also hands React's createElement to the runtime",
    patches: [
      self({
        find: ATOM_REGISTRY,
        replacement: {
          match: ATOM_REGISTRY,
          replace: "$1=$self.capture(`atomRegistry`,$2(),{createElement:$4.createElement})$3",
        },
      }),
    ],
  },
  {
    name: "router",
    summary: "TanStack router instance",
    patches: [
      self({
        find: ROUTER,
        replacement: { match: ROUTER, replace: "return $self.capture(`router`,$1({routeTree:$2,history:$3,context:{},defaultPreload:`intent`}))" },
      }),
    ],
  },
  {
    name: "shortcutDispatcher",
    summary: "registerCommands of the shortcut dispatcher",
    patches: [
      self({
        find: DISPATCHER,
        replacement: {
          match: DISPATCHER,
          replace: "function $1($2,$3={}){return $4($3.observe?$5:$3.capture?$6:$7,{commands:$2,options:$3})}$self.capture(`shortcutDispatcher`,{registerCommands:$1});",
        },
      }),
    ],
  },
  {
    // A real "Plugins" settings page: a route, a nav entry, a label and an icon. Four edits in three chunks.
    name: "settingsNav",
    summary: "settings navigation: /settings/plugins route, nav entry, label and icon",
    patches: [
      // main chunk: add a child route next to ChatSettingsAboutRoute, cloned from it
      self({
        find: /ChatSettingsAboutRoute:([\w$]+),ChatSettingsAccessRoute:/,
        replacement: {
          match: /ChatSettingsAboutRoute:([\w$]+),ChatSettingsAccessRoute:/,
          replace: "ChatSettingsPluginsRoute:$self.capture(`settingsNav`,$self.settingsRoute($1)),ChatSettingsAboutRoute:$1,ChatSettingsAccessRoute:",
        },
      }),
      // settingsSearch chunk: label + nav group ("More")
      self({
        find: "`/settings/labs`,`/settings/about`,`/settings/archived`]",
        replacement: [
          { match: "`/settings/labs`,`/settings/about`,`/settings/archived`]", replace: "`/settings/labs`,`/settings/about`,`/settings/archived`,`/settings/plugins`]" },
          { match: /"\/settings\/archived":([\w$]+)\(`Archive`\)\}/, replace: "\"/settings/archived\":$1(`Archive`),\"/settings/plugins\":$1(`Plugins`)}" },
        ],
      }),
      // settings layout chunk: icon map (an unknown path would render an undefined component)
      self({
        find: /"\/settings\/archived":([\w$]+)\},([\w$]+)=\{"\/settings\/diagnostics"/,
        replacement: {
          match: /"\/settings\/archived":([\w$]+)\},([\w$]+)=\{"\/settings\/diagnostics"/,
          replace: "\"/settings/archived\":$1,\"/settings/plugins\":$self.PluginsIcon},$2={\"/settings/diagnostics\"",
        },
      }),
    ],
  },
  {
    name: "commandPalette",
    summary: "command palette: plugin commands are added as one group in filterCommandPaletteGroups",
    patches: [
      self({
        find: /function [\w$]+\(([\w$]+)(?:,[\w$]+=(?:[\w$]+|\{\}))?\)\{if\(\1\.allOptions&&\1\.isInSubmenu\)\{let\{allOptions:/,
        replacement: [
          // idempotent: the function recurses with a copy of its input
          { match: /function ([\w$]+)\(([\w$]+)((?:,[\w$]+=(?:[\w$]+|\{\}))?)\)\{if\(\2\.allOptions&&\2\.isInSubmenu\)\{let\{allOptions:/, replace: "function $1($2$3){$2=$self.palette($2);if($2.allOptions&&$2.isInSubmenu){let{allOptions:" },
          { match: /export\{/, replace: "$self.capture(`commandPalette`,{});export{" },
        ],
      }),
    ],
  },
];

/** Names that `T3P_CAPTURES_OFF` (comma separated, or `all`) switches off, to exercise the fallbacks. */
export function disabledCaptures(env: NodeJS.ProcessEnv): Set<CaptureName> {
  const raw = (env.T3P_CAPTURES_OFF ?? "").trim();
  if (!raw) return new Set();
  if (raw === "all") return new Set(CAPTURE_NAMES);
  return new Set(raw.split(",").map((x) => x.trim()).filter((x): x is CaptureName => (CAPTURE_NAMES as readonly string[]).includes(x)));
}

/** The enabled capture patches, flat, in definition order. */
export function capturePatches(env: NodeJS.ProcessEnv): Patch[] {
  const off = disabledCaptures(env);
  return CAPTURES.filter((c) => !off.has(c.name)).flatMap((c) => c.patches);
}
