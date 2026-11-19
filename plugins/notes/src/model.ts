/** Pure logic of the Notes plugin: storage keys, project resolution, the autosave state machine. */

/** Id of the note that belongs to no project. */
export const GENERAL = "@general";
export const UI_KEY = "ui";
export const SAVE_DELAY_MS = 400;
export const DEFAULT_HEIGHT = 120;
export const MIN_HEIGHT = 60;
export const MAX_HEIGHT = 600;

/** Storage key of one note: `notes:<projectId>`, or `notes:@general`. */
export function noteKey(id: string): string {
  return `notes:${id}`;
}

export interface ProjectInfo {
  id: string;
  name: string;
  workspaceRoot: string | null;
}

/** The subset of a shell project record the plugin reads. */
export interface ProjectWire {
  id?: unknown;
  title?: unknown;
  workspaceRoot?: unknown;
  archivedAt?: unknown;
}

/** Last path segment of a folder path (either separator), or `null`. */
export function baseName(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/** A shell project record to a {@link ProjectInfo}; `null` when it has no usable id or is archived. */
export function projectFromWire(wire: ProjectWire | null | undefined): ProjectInfo | null {
  if (!wire || typeof wire.id !== "string" || wire.id.length === 0) return null;
  if (typeof wire.archivedAt === "string" && wire.archivedAt.length > 0) return null;
  const root = typeof wire.workspaceRoot === "string" && wire.workspaceRoot ? wire.workspaceRoot : null;
  const name = typeof wire.title === "string" && wire.title ? wire.title : (baseName(root) ?? wire.id);
  return { id: wire.id, name, workspaceRoot: root };
}

export type Resolution =
  | { kind: "project"; project: ProjectInfo }
  /** The thread has a project id but the project list does not know it (yet). */
  | { kind: "unknown-project"; projectId: string }
  | { kind: "no-thread" }
  | { kind: "no-project"; reason: string };

/** Project of the focused thread, from its shell record (`projectId`) and the known projects. */
export function resolveProject(threadId: string | null, thread: { projectId: string | null } | undefined, projects: ReadonlyMap<string, ProjectInfo>): Resolution {
  if (!threadId) return { kind: "no-thread" };
  if (!thread) return { kind: "no-project", reason: "thread is not in the shell stream yet" };
  if (!thread.projectId) return { kind: "no-project", reason: "thread has no project" };
  const project = projects.get(thread.projectId);
  return project ? { kind: "project", project } : { kind: "unknown-project", projectId: thread.projectId };
}

/** Which note the panel shows: the pinned one, else the current project's, else General. */
export function selectedId(pinned: string | null, resolution: Resolution): string {
  if (pinned) return pinned;
  if (resolution.kind === "project") return resolution.project.id;
  if (resolution.kind === "unknown-project") return resolution.projectId;
  return GENERAL;
}

export interface MenuEntry {
  id: string;
  label: string;
  /** The project of the focused thread. */
  current: boolean;
}

/** Dropdown rows: the current project first, the others by name, General last. */
export function menuEntries(projects: ReadonlyMap<string, ProjectInfo>, currentId: string | null): MenuEntry[] {
  const rows = [...projects.values()].map((p) => ({ id: p.id, label: p.name, current: p.id === currentId }));
  rows.sort((a, b) => Number(b.current) - Number(a.current) || a.label.localeCompare(b.label));
  rows.push({ id: GENERAL, label: "General", current: false });
  return rows;
}

export function clampHeight(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_HEIGHT;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(n)));
}

export interface UiState {
  collapsed: boolean;
  height: number;
}

export function parseUi(value: unknown): UiState {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { collapsed: v.collapsed === true, height: clampHeight(v.height) };
}

/** Tooltip text: size of a note. */
export function describeCount(text: string): string {
  const chars = [...text].length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return `${chars} character${chars === 1 ? "" : "s"}, ${words} word${words === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------------------------

/** `saved` grey; `dirty`, `saving` and `error` amber. */
export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export interface AutosaverDeps {
  save(key: string, text: string): Promise<void>;
  onStatus(status: SaveStatus, error?: string): void;
  delayMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/**
 * Debounced writer for one edited note at a time. `edit` marks dirty and (re)arms the timer.
 * Editing another key writes the pending one first, so a switch never loses text. `flush` writes
 * now (blur, unload, navigation). A failed write keeps the text pending and reports `error`.
 */
export class Autosaver {
  #pending: { key: string; text: string } | null = null;
  #timer: unknown = null;
  #inflight = 0;
  #failed: string | null = null;
  #status: SaveStatus = "saved";
  readonly #delay: number;
  readonly #set: (fn: () => void, ms: number) => unknown;
  readonly #clear: (handle: unknown) => void;

  constructor(private readonly deps: AutosaverDeps) {
    this.#delay = deps.delayMs ?? SAVE_DELAY_MS;
    this.#set = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clear = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get status(): SaveStatus {
    return this.#status;
  }

  /** Text not yet written for `key`, or `undefined`. Lets a re-render show unsaved text. */
  pendingText(key: string): string | undefined {
    return this.#pending?.key === key ? this.#pending.text : undefined;
  }

  edit(key: string, text: string): void {
    if (this.#pending && this.#pending.key !== key) void this.flush();
    this.#pending = { key, text };
    this.#failed = null;
    if (this.#timer !== null) this.#clear(this.#timer);
    this.#timer = this.#set(() => void this.flush(), this.#delay);
    this.#report();
  }

  async flush(): Promise<void> {
    if (this.#timer !== null) {
      this.#clear(this.#timer);
      this.#timer = null;
    }
    const job = this.#pending;
    if (!job) return;
    this.#pending = null;
    this.#failed = null;
    this.#inflight += 1;
    this.#report();
    try {
      await this.deps.save(job.key, job.text);
    } catch (error) {
      // Keep the text unless the user typed something newer meanwhile.
      this.#pending ??= job;
      this.#failed = error instanceof Error ? error.message : String(error);
    } finally {
      this.#inflight -= 1;
      this.#report();
    }
  }

  #report(): void {
    const next: SaveStatus = this.#failed !== null && this.#inflight === 0 ? "error" : this.#inflight > 0 ? "saving" : this.#pending ? "dirty" : "saved";
    if (next === this.#status && next !== "error") return;
    this.#status = next;
    this.deps.onStatus(next, this.#failed ?? undefined);
  }
}
