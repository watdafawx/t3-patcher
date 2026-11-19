import type { KeybindRegistration, T3Disposable, T3Keybinds } from "@t3p/api";

import type { CommandRegistry } from "./commands.js";
import type { InternalsHub } from "./internals.js";
import type { Scope } from "./scope.js";
import { isEditableTarget } from "./ui/dom.js";

export interface Chord {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  mod: boolean;
}

const ALIASES: Record<string, string> = { esc: "escape", return: "enter", space: " ", spacebar: " ", del: "delete", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", plus: "+" };

/** `"mod+shift+k"` -> chord. `mod` is Cmd on macOS and Ctrl elsewhere. Throws on an empty or modifier-only chord. */
export function parseChord(text: string): Chord {
  const parts = String(text).toLowerCase().split("+").map((p) => p.trim());
  const chord: Chord = { key: "", ctrl: false, meta: false, alt: false, shift: false, mod: false };
  for (const part of parts) {
    if (part === "mod") chord.mod = true;
    else if (part === "ctrl" || part === "control") chord.ctrl = true;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "super") chord.meta = true;
    else if (part === "alt" || part === "option") chord.alt = true;
    else if (part === "shift") chord.shift = true;
    else if (part !== "") {
      if (chord.key) throw new Error(`t3.keybinds.register: chord "${text}" has two keys`);
      chord.key = ALIASES[part] ?? part;
    }
  }
  if (!chord.key) throw new Error(`t3.keybinds.register: chord "${text}" has no key`);
  return chord;
}

export function matchesChord(chord: Chord, event: KeyboardEvent, mac: boolean): boolean {
  const wantMeta = chord.meta || (chord.mod && mac);
  const wantCtrl = chord.ctrl || (chord.mod && !mac);
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl || event.altKey !== chord.alt || event.shiftKey !== chord.shift) return false;
  const key = String(event.key).toLowerCase();
  const code = String(event.code ?? "").toLowerCase();
  return key === chord.key || code === `key${chord.key}` || code === `digit${chord.key}`;
}

interface Bound {
  plugin: string;
  reg: KeybindRegistration;
  chord: Chord;
}

/**
 * `t3.keybinds`. When the app's shortcut dispatcher is captured, the keybinds run through it
 * (`registerCommands({}, {onKeyDown})`, which only consumes the event when a keybind matched).
 * Otherwise a guarded document-level keydown listener does it and ignores inputs, textareas and
 * other editable targets.
 */
export class KeybindRegistry {
  readonly #bound = new Map<string, Bound>();
  #mode: "dispatcher" | "document" | null = null;
  #off: (() => void) | null = null;
  readonly #mac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");

  constructor(
    private readonly commands: CommandRegistry,
    private readonly hub: InternalsHub,
    private readonly onError: (plugin: string, error: unknown) => void,
  ) {
    hub.substitute("shortcutDispatcher", "guarded document keydown listener (ignores editable targets)");
    hub.whenCaptured("shortcutDispatcher", () => this.refresh());
  }

  get mode(): "dispatcher" | "document" | null {
    return this.#mode;
  }

  add(plugin: string, reg: KeybindRegistration): () => void {
    if (!reg || typeof reg.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(reg.id)) throw new Error("t3.keybinds.register: id must match [A-Za-z0-9._-]+");
    if (typeof reg.command !== "string" || reg.command === "") throw new Error("t3.keybinds.register: command is required");
    const key = `${plugin}:${reg.id}`;
    if (this.#bound.has(key)) throw new Error(`t3.keybinds.register: ${key} is already registered`);
    const bound: Bound = { plugin, reg: { ...reg }, chord: parseChord(reg.key) };
    this.#bound.set(key, bound);
    this.#ensure();
    return () => {
      if (this.#bound.get(key) === bound) this.#bound.delete(key);
      if (this.#bound.size === 0) this.#teardown();
    };
  }

  list(): Array<KeybindRegistration & { plugin: string }> {
    return [...this.#bound.values()].map((b) => ({ ...b.reg, plugin: b.plugin }));
  }

  /** Runs the first matching keybind. Returns true when one matched. */
  handle(event: KeyboardEvent, guardEditable: boolean): boolean {
    for (const bound of this.#bound.values()) {
      if (!matchesChord(bound.chord, event, this.#mac)) continue;
      const modified = bound.chord.ctrl || bound.chord.meta || bound.chord.alt || bound.chord.mod;
      if (isEditableTarget(event.target) && (guardEditable || !modified)) continue;
      event.preventDefault();
      this.commands.run(bound.reg.command).catch((error: unknown) => this.onError(bound.plugin, error));
      return true;
    }
    return false;
  }

  /** Re-evaluates the mode (the dispatcher capture may arrive after the first keybind). */
  refresh(): void {
    if (this.#bound.size > 0) {
      this.#teardown();
      this.#ensure();
    }
  }

  #ensure(): void {
    if (this.#off) return;
    const dispatcher = this.hub.get("shortcutDispatcher") as { registerCommands?: (commands: object, options: object) => () => void } | null;
    if (dispatcher && typeof dispatcher.registerCommands === "function") {
      try {
        this.#off = dispatcher.registerCommands({}, { capture: true, onKeyDown: (event: KeyboardEvent) => this.handle(event, false) });
        this.#mode = "dispatcher";
        return;
      } catch (error) {
        this.onError("t3p.core", error);
      }
    }
    const listener = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      this.handle(event, true);
    };
    document.addEventListener("keydown", listener, true);
    this.#off = () => document.removeEventListener("keydown", listener, true);
    this.#mode = "document";
  }

  #teardown(): void {
    this.#off?.();
    this.#off = null;
    this.#mode = null;
  }

  namespace(plugin: string, scope: Scope): T3Keybinds {
    return Object.freeze({
      register: (reg: KeybindRegistration): T3Disposable => {
        scope.assertAlive();
        const remove = this.add(plugin, reg);
        const forget = scope.add(remove);
        return Object.freeze({ dispose: () => forget() });
      },
      list: () => this.list(),
    });
  }
}
