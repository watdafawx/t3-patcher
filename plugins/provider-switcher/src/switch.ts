import type { ModelSelection, SwitchResult, T3Api } from "@t3p/api";

import type { Selection, SwitchKind } from "./logic/types.js";
import { projectionView } from "./map.js";
import type { SwitchQueue } from "./queue.js";

/** One switch the user asked for, with the labels its messages use. */
export interface SwitchRequest {
  threadId: string;
  selection: Selection;
  kind: SwitchKind;
  providerLabel: string;
  modelLabel: string;
}

/** Only one busy prompt at a time; a second one would stack modals. */
let offeringQueue = false;

/** The focused thread and its current selection, or `null` outside a thread / when it cannot be read. */
export async function focusedThreadSelection(t3: T3Api): Promise<{ threadId: string; selection: Selection } | null> {
  const threadId = t3.threads.current();
  if (!threadId) return null;
  const projection = await t3.threads.projection(threadId);
  const selection = projectionView(projection).modelSelection;
  return selection ? { threadId, selection } : null;
}

const labels = (request: SwitchRequest): string => `${request.providerLabel} · ${request.modelLabel}`;

/**
 * Runs one switch and handles every outcome: `ok` toasts, `busy` offers to queue it for when the run
 * ends (the queue does the retry), `unavailable`/`error` toast the server's message. Never throws.
 */
export async function performSwitch(t3: T3Api, queue: SwitchQueue, request: SwitchRequest): Promise<void> {
  const selection: ModelSelection = {
    providerInstanceId: request.selection.providerInstanceId,
    model: request.selection.model,
  };
  let result: SwitchResult;
  try {
    result =
      request.kind === "model"
        ? await t3.threads.setModel(request.threadId, selection)
        : await t3.threads.switchProvider(request.threadId, selection);
  } catch (error) {
    t3.log("warn", `switch to ${labels(request)} failed: ${String(error)}`);
    t3.ui.toast({
      title: "Switch failed",
      message: error instanceof Error ? error.message : String(error),
      kind: "error",
    });
    return;
  }

  switch (result.status) {
    case "ok":
      t3.ui.toast({ title: "Switched", message: labels(request), kind: "success" });
      return;
    case "busy":
      await offerQueue(t3, queue, request, result.message);
      return;
    case "unavailable":
    case "error":
      t3.ui.toast({
        title: request.kind === "model" ? "Model not switched" : "Provider not switched",
        message: result.message?.trim() || labels(request),
        kind: "warning",
        durationMs: 8000,
      });
      return;
  }
}

async function offerQueue(t3: T3Api, queue: SwitchQueue, request: SwitchRequest, message: string): Promise<void> {
  if (offeringQueue) {
    t3.ui.toast({
      title: "Switch not applied",
      message: `${labels(request)}: ${message || "a run is active."} Another switch prompt is already open.`,
      kind: "info",
    });
    return;
  }
  offeringQueue = true;
  try {
    const choice = await t3.ui.modal({
      title: "A run is active",
      body: `${labels(request)} cannot be selected while a run is active. Switch when the run ends?`,
      buttons: ["Cancel", "Switch when the run ends"],
    });
    if (choice !== 1) return;
    queue.request({ threadId: request.threadId, selection: request.selection, kind: request.kind });
    t3.ui.toast({
      title: "Switch queued",
      message: `${labels(request)}: waiting for the run to end. Cancel it from the thread header.`,
      kind: "info",
      durationMs: 6000,
    });
  } finally {
    offeringQueue = false;
  }
}
