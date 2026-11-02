import { performance } from "node:perf_hooks";
import type { PeerConfig } from "../config.js";
import { keyPairFromSeed, type DhtNode } from "../mux/hyperdht.js";
import { loadPeerIdentity } from "../state/peer.js";
import { startVpnEngine, type PacketDevice } from "./engine.js";
import { openLinuxTun } from "./linux-tun.js";

/** Linux CLI adapter. The engine accepts packet devices from other platforms. */
export async function startVpn(options: {
  stateDir: string;
  config: PeerConfig;
  helper: string;
  dht?: DhtNode;
  openTun?: (options: { helper: string; address: string; peerAddresses: readonly string[]; dialerPeerAddresses?: readonly string[]; checkRouteConflicts?: boolean }) => Promise<PacketDevice>;
  log?: (message: string) => void;
  onPeerStatus?: (peer: { key: string; label: string; connected: boolean }) => void;
  now?: () => number;
  enrollment?: Parameters<typeof startVpnEngine>[0]["enrollment"];
}): ReturnType<typeof startVpnEngine> {
  if (!options.config.vpn) throw new Error("VPN mode requires a [vpn] configuration");
  const identity = await loadPeerIdentity(options.stateDir);
  const dialerPeerAddresses = options.config.vpn.peers.filter((peer) =>
    options.config.peers.some((definition) =>
      (definition.label === peer.peer || definition.publicKey === peer.peer) && definition.connection === "dial"),
  ).map((peer) => peer.address);
  return startVpnEngine({
    keyPair: keyPairFromSeed(identity.seed),
    config: options.config,
    dht: options.dht,
    openTun: (deviceOptions) => (options.openTun ?? openLinuxTun)({ ...deviceOptions, helper: options.helper, checkRouteConflicts: !!options.enrollment,
      dialerPeerAddresses }),
    log: options.log,
    onPeerStatus: options.onPeerStatus,
    enrollment: options.enrollment,
    now: options.now ?? (() => performance.now()),
  });
}
