import b4a from "b4a";
import { performance } from "node:perf_hooks";
import { createDht, dhtStreamSnapshot, keyPairFromSeed, type DhtNode, type DhtStream } from "../mux/hyperdht.js";
import { connectionOptionsForRoute } from "../mux/route.js";
import type { PeerConfig } from "../config.js";
import { loadPeerIdentity } from "../state/peer.js";
import { cleanupAll } from "../runtime/cleanup.js";
import { PacketFraming } from "./framing.js";
import { openLinuxTun } from "./linux-tun.js";
import { PacketPolicy } from "./packet-policy.js";

const hello = Buffer.from("Kepos VPN IPv4 v1\0\0\0", "ascii");
type Tun = Awaited<ReturnType<typeof openLinuxTun>>;
type Peer = { label: string; key: string; address: string; direction: "dial" | "accept"; allowTcp: "all" | number[] };
type Session = { stream: DhtStream; frames: PacketFraming; policy: PacketPolicy; ready: boolean };

// Transport exceptions are not trusted log content: they may contain remote data.
function diagnosticError(error: unknown): string {
  const known = new Set([
    "Stream was destroyed", "VPN stream is closed", "VPN stream closed during write",
    "VPN protocol mismatch", "VPN protocol handshake missing",
    "VPN protocol handshake timed out after 10000ms", "invalid VPN frame length",
    "truncated VPN frame", "VPN connection timed out", "VPN connection closed",
    "VPN peer identity mismatch", "PEER_CONNECTION_FAILED: Could not connect to peer",
  ]);
  if (error instanceof Error && known.has(error.message)) return error.message;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const allowedCodes = new Set([
    "BAD_HANDSHAKE_REPLY", "BAD_HOLEPUNCH_REPLY", "HOLEPUNCH_ABORTED", "HOLEPUNCH_INVALID",
    "HOLEPUNCH_PROBE_TIMEOUT", "HOLEPUNCH_DOUBLE_RANDOMIZED_NATS", "CANNOT_HOLEPUNCH",
    "REMOTE_NOT_HOLEPUNCHING", "REMOTE_NOT_HOLEPUNCHABLE", "REMOTE_ABORTED", "HANDSHAKE_UNFINISHED",
    "HANDSHAKE_INVALID", "NODE_DESTROYED", "PEER_CONNECTION_FAILED", "PEER_NOT_FOUND",
    "STREAM_NOT_CONNECTED", "SERVER_INCOMPATIBLE", "SERVER_ERROR", "DUPLICATE_CONNECTION",
    "RELAY_ABORTED", "SUSPENDED", "STREAM_DESTROYED", "PREMATURE_CLOSE", "ABORTED", "BAD_ARGUMENT",
  ]);
  if (typeof code === "string" && allowedCodes.has(code)) return `transport error (${code})`;
  return "transport error";
}

export async function startVpn(options: {
  stateDir: string;
  config: PeerConfig;
  helper: string;
  dht?: DhtNode;
  openTun?: (options: { helper: string; address: string; peerAddresses: readonly string[] }) => Promise<Tun>;
  log?: (message: string) => void;
  now?: () => number;
}): Promise<{ peerKey: string; interfaceName: string; failed: Promise<Error>; stop: () => Promise<void> }> {
  const vpn = options.config.vpn;
  if (!vpn) throw new Error("VPN mode requires a [vpn] configuration");
  const identity = await loadPeerIdentity(options.stateDir);
  const keyPair = keyPairFromSeed(identity.seed);
  const peerKey = b4a.toString(keyPair.publicKey, "hex");
  const peers: Peer[] = vpn.peers.map((entry) => {
    const definition = options.config.peers.find((peer) => peer.label === entry.peer || peer.publicKey === entry.peer);
    if (!definition) throw new Error(`Unknown VPN peer: ${entry.peer}`);
    if (definition.publicKey === peerKey) throw new Error("VPN config cannot include its own key");
    return { label: definition.label, key: definition.publicKey, address: entry.address, direction: definition.connection, allowTcp: entry.allowTcp };
  });
  const byKey = new Map(peers.map((peer) => [peer.key, peer]));
  const byAddress = new Map(peers.map((peer) => [peer.address, peer]));
  const sessions = new Map<string, Session>();
  const lastAdmissions = new Map<string, number>();
  const now = options.now ?? (() => performance.now());
  const admissionLogs = new Map<string, number>();
  let lastUnknownAdmissionLog: number | undefined;
  const streams = new Set<DhtStream>();
  let stopping = false;
  let stopTask: Promise<void> | undefined;
  let tun: Tun | undefined;
  let server: ReturnType<DhtNode["createServer"]> | undefined;
  const dht = options.dht ?? createDht({ keyPair, bootstrap: options.config.network?.bootstrap });
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => { rejectFailure = resolve; });
  let tunWriting = false;

  function logAdmission(peer: Peer, message: string): void {
    const timestamp = now();
    const logKey = `${peer.key}:${message}`;
    const last = admissionLogs.get(logKey);
    if (last !== undefined && timestamp - last < 5_000) return;
    admissionLogs.set(logKey, timestamp);
    options.log?.(`VPN admission for ${peer.label}: ${message}`);
  }
  function attach(peer: Peer, stream: DhtStream): void {
    if (stopping || sessions.has(peer.key)) { stream.destroy(); return; }
    streams.add(stream);
    stream.on("error", () => undefined);
    const session: Session = { stream, frames: new PacketFraming(stream), policy: new PacketPolicy(vpn!.address, peer.address, peer.allowTcp), ready: false };
    sessions.set(peer.key, session);
    const timeout = setTimeout(() => {
      if (!session.ready) {
        let snapshot = "unavailable";
        try {
          const { publicKey: _publicKey, remotePublicKey: _remotePublicKey, ...safe } = dhtStreamSnapshot(stream) as Record<string, unknown>;
          snapshot = JSON.stringify(safe);
        } catch { /* diagnostic data is optional */ }
        options.log?.(`VPN handshake timeout with ${peer.label}: transport=${snapshot}`);
        stream.destroy(new Error("VPN protocol handshake timed out after 10000ms"));
      }
    }, 10_000);
    stream.once("close", () => {
      clearTimeout(timeout);
      streams.delete(stream);
      session.policy.clear();
      if (sessions.get(peer.key) === session) sessions.delete(peer.key);
    });
    void (async () => {
      await session.frames.send(hello);
      let first = true;
      await session.frames.receive(async (packet) => {
        if (sessions.get(peer.key) !== session || stopping) return;
        if (first) {
          first = false;
          if (!packet.equals(hello)) throw new Error("VPN protocol mismatch");
          session.ready = true;
          clearTimeout(timeout);
          options.log?.(`VPN peer connected: ${peer.label}`);
          return;
        }
        if (tunWriting || !tun || !session.policy.admit(packet, "in")) return;
        tunWriting = true;
        try { await tun.packets.send(packet); } finally { tunWriting = false; }
      });
      if (first) throw new Error("VPN protocol handshake missing");
    })().catch((error: unknown) => {
      if (!stopping) {
        const phase = session.ready ? "session" : "handshake";
        options.log?.(`VPN ${phase} with ${peer.label} failed: ${diagnosticError(error)}`);
      }
    }).finally(() => stream.destroy());
  }
  async function dial(peer: Peer): Promise<void> {
    while (!stopping) {
      let stream: DhtStream | undefined;
      try {
        stream = dht.connect(Buffer.from(peer.key, "hex"), { keyPair, ...connectionOptionsForRoute(options.config.network?.route ?? "auto") });
        const connection = stream;
        streams.add(connection);
        connection.on("error", () => undefined);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error("VPN connection timed out")); }, 20_000);
          const cleanup = (): void => { clearTimeout(timer); connection.off("connect", connected); connection.off("close", closed); connection.off("error", failedConnect); };
          const connected = (): void => { cleanup(); resolve(); };
          const closed = (): void => { cleanup(); reject(new Error("VPN connection closed")); };
          const failedConnect = (error: Error): void => { cleanup(); reject(error); };
          connection.once("connect", connected); connection.once("close", closed); connection.once("error", failedConnect);
          if (connection.connected) connected();
        });
        if (stopping) { connection.destroy(); return; }
        if (b4a.toString(connection.remotePublicKey, "hex") !== peer.key) throw new Error("VPN peer identity mismatch");
        options.log?.(`VPN transport opened locally to ${peer.label}; awaiting protocol handshake`);
        attach(peer, connection);
        await new Promise<void>((resolve) => { if (connection.destroyed) resolve(); else connection.once("close", resolve); });
      } catch (error) {
        if (!stopping) options.log?.(`VPN dial to ${peer.label} failed before transport connected: ${diagnosticError(error)}`);
        stream?.destroy();
      } finally { if (stream) streams.delete(stream); }
      if (!stopping) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }
  async function stop(): Promise<void> {
    stopTask ??= (async () => {
      stopping = true;
      for (const session of sessions.values()) session.policy.clear();
      sessions.clear();
      for (const stream of streams) stream.destroy();
      await cleanupAll([
        () => server?.close(),
        () => tun?.close(),
        () => options.dht ? undefined : dht.destroy({ force: true }),
      ]);
    })();
    await stopTask;
  }
  try {
    tun = await (options.openTun ?? openLinuxTun)({ helper: options.helper, address: vpn.address, peerAddresses: peers.map((peer) => peer.address) });
    const device = tun;
    void device.closed.then((error) => { if (!stopping) rejectFailure(error); });
    server = dht.createServer({ reusableSocket: true, firewall: (publicKey) => {
      const key = b4a.toString(publicKey, "hex");
      const peer = byKey.get(key);
      if (!peer || peer.direction !== "accept") {
        const timestamp = now();
        if (lastUnknownAdmissionLog === undefined || timestamp - lastUnknownAdmissionLog >= 5_000) {
          lastUnknownAdmissionLog = timestamp;
          options.log?.("VPN admission rejected: peer is unknown or not configured to accept");
        }
        return true;
      }
      if (sessions.has(key)) {
        logAdmission(peer, "rejected because a session is already active");
        return true;
      }
      const timestamp = now();
      const last = lastAdmissions.get(key);
      if (last !== undefined && timestamp - last < 1_000) {
        logAdmission(peer, "rejected by handshake retry rate limit");
        return true;
      }
      lastAdmissions.set(key, timestamp);
      logAdmission(peer, "authenticated handshake admitted");
      return false;
    } }, (stream) => {
      const key = b4a.toString(stream.remotePublicKey, "hex");
      const peer = byKey.get(key);
      if (!peer || peer.direction !== "accept" || stopping) { stream.destroy(); return; }
      options.log?.(`VPN transport accepted from ${peer.label}; awaiting protocol handshake`);
      attach(peer, stream);
    });
    await server.listen(keyPair);
    options.log?.(`VPN DHT listening: bootstrap=${options.config.network?.bootstrap?.length ? "configured" : "default"} route=${options.config.network?.route ?? "auto"} peers=${peers.length}`);
    void device.packets.receive(async (packet) => {
      if (packet.length < 20 || packet[0]! >>> 4 !== 4) return;
      const destination = Array.from(packet.subarray(16, 20)).join(".");
      const peer = byAddress.get(destination);
      if (!peer) return;
      const session = sessions.get(peer.key);
      if (!session?.ready || !session.policy.admit(packet, "out")) return;
      try { await session.frames.send(packet); }
      catch { session.stream.destroy(); }
    }).then(() => { if (!stopping) rejectFailure(new Error("TUN packet stream closed")); }, (error: unknown) => {
      if (!stopping) rejectFailure(error instanceof Error ? error : new Error(String(error)));
    });
    for (const peer of peers) if (peer.direction === "dial") void dial(peer);
    return { peerKey, interfaceName: device.name, failed, stop };
  } catch (error) { await stop(); throw error; }
}
