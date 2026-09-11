import type { Observe } from "../../../src/mux/observability.js";
import { renderSVG } from "uqr";
import {
  startPeer,
  type PeerRuntimeStatus,
  type RunningPeer,
} from "../../../src/runtime/peer.js";
import type { PeerConfig } from "../../../src/config.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import type { RuntimeLock } from "../../../src/runtime/runtime-lock.js";
import type {
  DesktopPeerRole,
  DesktopService,
  DesktopSnapshot,
} from "./protocol.js";
import type {
  DesktopRuntimeConfiguration,
  RunningDesktopRuntime,
  StartDesktopRuntimeOptions,
} from "./runtime.js";

export interface StartDesktopPeerRuntimeOptions {
  stateDir: string;
  config: PeerConfig;
  configPath?: string;
  lock?: RuntimeLock;
  bootstrap?: DhtAddress[];
}

export async function startDesktopPeerRuntime(
  options: StartDesktopPeerRuntimeOptions,
  onSnapshot: (snapshot: DesktopSnapshot) => void,
  onObservation?: Observe,
): Promise<RunningDesktopRuntime> {
  let stopped = false;
  let running: RunningPeer | undefined;
  let stopTask: Promise<void> | undefined;
  let pairingInvitation:
    | { uri: string; expiresAt: number; qrSvg: string }
    | undefined;
  const publish = (): void => {
    if (!running) return;
    onSnapshot({
      type: "snapshot",
      appPhase: stopped ? "stopped" : "running",
      peer: peerRole(running.status(), pairingInvitation),
    });
  };

  try {
    running = await startPeer({
      stateDir: options.stateDir,
      config: options.config,
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(onObservation ? { observe: onObservation } : {}),
    });
  } catch (error) {
    await options.lock?.release().catch(() => undefined);
    throw error;
  }
  publish();

  return {
    approvePairing: async () => {
      await running?.approvePairing();
      pairingInvitation = undefined;
      publish();
    },
    cancelPairing: async () => {
      running?.cancelPairing();
      pairingInvitation = undefined;
      publish();
    },
    createPairingInvitation: async () => {
      const invitation = running?.createPairingInvitation();
      if (invitation) {
        pairingInvitation = {
          ...invitation,
          qrSvg: renderSVG(invitation.uri, {
            ecc: "M",
            border: 1,
            blackColor: "#0d1209",
            whiteColor: "#f0f1e7",
          }),
        };
      }
      publish();
    },
    denyPairing: async () => {
      running?.denyPairing();
      pairingInvitation = undefined;
      publish();
    },
    poll: async () => publish(),
    reconfigure: async (configuration: DesktopRuntimeConfiguration) => {
      if (!configuration.peer) {
        throw new Error("desktop peer configuration is required");
      }
      await running?.applyConfig(configuration.peer.config);
      publish();
    },
    stop: async () => {
      stopTask ??= (async () => {
        stopped = true;
        await running?.stop();
        await options.lock?.release();
        publish();
      })();
      return stopTask;
    },
  };
}

function peerRole(
  status: PeerRuntimeStatus,
  pairingInvitation?: { uri: string; expiresAt: number; qrSvg: string },
): DesktopPeerRole {
  const pairing =
    status.pairing.phase === "inviting" && pairingInvitation
      ? { ...status.pairing, ...pairingInvitation }
      : status.pairing;
  return {
    phase: status.state === "running" ? "running" : "stopped",
    peerKey: status.peerKey,
    gatewayPort: status.gateway.port,
    connections: status.connections.map((connection) => ({ ...connection })),
    services: status.services.map((service) => ({ ...service })),
    bindings: status.bindings.map((binding) => ({ ...binding })),
    pairing,
  };
}
