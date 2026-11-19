import { FuseState as WireState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";

import type { FuseState, ReadFuses } from "./types.js";

/**
 * Reads the Electron fuses from an installed exe.
 *
 * @electron/fuses exposes `getCurrentFuseWire`; the brief called it
 * `getCurrentFuseWireConfig`, which does not exist in 2.1.3.
 */
export const readFusesFromExe: ReadFuses = async (exePath: string): Promise<FuseState> => {
  const wire = await getCurrentFuseWire(exePath);
  const isEnabled = (option: FuseV1Options): boolean => wire[option] === WireState.ENABLE;
  return {
    onlyLoadAppFromAsar: isEnabled(FuseV1Options.OnlyLoadAppFromAsar),
    embeddedAsarIntegrityValidation: isEnabled(FuseV1Options.EnableEmbeddedAsarIntegrityValidation),
    runAsNode: isEnabled(FuseV1Options.RunAsNode),
  };
};

/** True when the fuse layout lets a replacement app.asar load. */
export function fusesAreSafe(fuses: FuseState): boolean {
  return !fuses.onlyLoadAppFromAsar && !fuses.embeddedAsarIntegrityValidation;
}

export function describeFuses(fuses: FuseState): string {
  return [
    `onlyLoadAppFromAsar=${fuses.onlyLoadAppFromAsar}`,
    `embeddedAsarIntegrityValidation=${fuses.embeddedAsarIntegrityValidation}`,
    `runAsNode=${fuses.runAsNode}`,
  ].join(", ");
}
