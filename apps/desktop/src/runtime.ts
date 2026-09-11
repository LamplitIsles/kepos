import type { Observe } from "../../../src/mux/observability.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import {
  startDesktopPeerRuntime,
  type StartDesktopPeerRuntimeOptions,
} from "./peer-runtime.js";
import type { DesktopSnapshot } from "./protocol.js";

/** The only repository-owned desktop runtime configuration. */
export interface StartDesktopRuntimeOptions {
  peer: StartDesktopPeerRuntimeOptions;
  bootstrap?: DhtAddress[];
  onSnapshot(snapshot: DesktopSnapshot): void;
  onObservation?: Observe;
}

export interface DesktopRuntimeConfiguration {
  peer: StartDesktopPeerRuntimeOptions;
}

export interface DesktopRuntimeDependencies {
  startPeerRuntime: typeof startDesktopPeerRuntime;
}

export interface RunningDesktopRuntime {
  approvePairing(): Promise<void>;
  cancelPairing(): Promise<void>;
  createPairingInvitation(): Promise<void>;
  denyPairing(): Promise<void>;
  poll(): Promise<void>;
  reconfigure(configuration: DesktopRuntimeConfiguration): Promise<void>;
  stop(): Promise<void>;
}

const defaultDependencies: DesktopRuntimeDependencies = {
  startPeerRuntime: startDesktopPeerRuntime,
};

export async function startDesktopRuntime(
  options: StartDesktopRuntimeOptions,
  dependencies: DesktopRuntimeDependencies = defaultDependencies,
): Promise<RunningDesktopRuntime> {
  if (!options.peer) {
    throw new Error("desktop peer configuration is required");
  }
  return dependencies.startPeerRuntime(
    options.peer,
    options.onSnapshot,
    options.onObservation,
  );
}
