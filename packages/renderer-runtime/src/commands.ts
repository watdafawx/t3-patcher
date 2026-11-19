import type { CommandRegistration, JsonValue, T3Commands, T3Disposable } from "@t3p/api";

import type { Scope } from "./scope.js";

interface Entry {
  globalId: string;
  plugin: string;
  title: string;
  description: string;
  keywords: string[];
  run(args?: JsonValue): void | Promise<void>;
}

export interface PaletteItem {
  kind: "action";
  value: string;
  searchTerms: string[];
  title: string;
  description: string;
  icon: null;
  run(): Promise<void>;
}

/** Global command registry shared by every plugin. Entries show in the command palette (patch or DOM fallback). */
export class CommandRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(private readonly onError: (plugin: string, error: unknown) => void) {}

  get version(): number {
    return this.#version;
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  add(plugin: string, command: CommandRegistration): () => void {
    if (!command || typeof command.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(command.id)) throw new Error("t3.commands.register: id must match [A-Za-z0-9._-]+");
    if (typeof command.title !== "string" || command.title.trim() === "") throw new Error("t3.commands.register: title is required");
    if (typeof command.run !== "function") throw new Error("t3.commands.register: run must be a function");
    const globalId = `${plugin}:${command.id}`;
    if (this.#entries.has(globalId)) throw new Error(`t3.commands.register: ${globalId} is already registered`);
    const entry: Entry = {
      globalId,
      plugin,
      title: command.title,
      description: command.description ?? "",
      keywords: Array.isArray(command.keywords) ? command.keywords.filter((k) => typeof k === "string") : [],
      run: command.run,
    };
    this.#entries.set(globalId, entry);
    this.#bump();
    return () => {
      if (this.#entries.get(globalId) === entry) {
        this.#entries.delete(globalId);
        this.#bump();
      }
    };
  }

  async run(globalId: string, args?: JsonValue): Promise<void> {
    const entry = this.#entries.get(globalId);
    if (!entry) throw new Error(`t3.commands.run: unknown command ${globalId}`);
    try {
      await entry.run(args);
    } catch (error) {
      this.onError(entry.plugin, error);
      throw error;
    }
  }

  list(): Array<{ id: string; title: string; plugin: string }> {
    return [...this.#entries.values()].map((e) => ({ id: e.globalId, title: e.title, plugin: e.plugin }));
  }

  has(globalId: string): boolean {
    return this.#entries.has(globalId);
  }

  /** Items in the shape of the app's command palette. */
  paletteItems(): PaletteItem[] {
    return [...this.#entries.values()].map((e) => ({
      kind: "action" as const,
      value: `t3p:${e.globalId}`,
      searchTerms: [e.title, e.globalId, ...e.keywords],
      title: e.title,
      description: e.description || e.plugin,
      icon: null,
      run: async () => {
        await this.run(e.globalId).catch(() => undefined);
      },
    }));
  }

  /** The `t3.commands` of one plugin. Its registrations end with the plugin's scope. */
  namespace(plugin: string, scope: Scope): T3Commands {
    return Object.freeze({
      register: (command: CommandRegistration): T3Disposable => {
        scope.assertAlive();
        const remove = this.add(plugin, command);
        const forget = scope.add(remove);
        return Object.freeze({ dispose: () => forget() });
      },
      run: (globalId: string, args?: JsonValue) => this.run(String(globalId), args),
      list: () => this.list(),
    });
  }

  #bump(): void {
    this.#version += 1;
    for (const fn of [...this.#listeners]) {
      try {
        fn();
      } catch {
        // a listener must not break registration
      }
    }
  }
}
