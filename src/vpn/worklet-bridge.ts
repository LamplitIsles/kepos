import type { Duplex } from "node:stream";
import { parseKeposConfig } from "../config-toml.js";
import { keyPairFromSeed } from "../mux/hyperdht.js";
import { VPN_MTU } from "./packet-policy.js";
import { startVpnEngine, type PacketDevice } from "./engine.js";
import { IPC_CONTROL, IPC_PACKET, WorkletFraming } from "./worklet-framing.js";
import { setAcceptanceSink } from "./acceptance-diagnostics.js";
import { pairWithReceiver, PairError } from "./pair.js";

type StartEngine = typeof startVpnEngine;
type Runtime = Awaited<ReturnType<StartEngine>>;

/** Run one provider-owned engine until IPC closes. No secret is sent back. */
export async function runWorkletBridge(stream: Duplex, startEngine: StartEngine = startVpnEngine, pair: typeof pairWithReceiver = pairWithReceiver): Promise<void> {
  const frames = new WorkletFraming(stream);
  let state: "initial" | "settings" | "starting" | "running" | "stopped" = "initial";
  let runtime: Runtime | undefined;
  let startup: Promise<void> | undefined;
  let config: ReturnType<typeof parseKeposConfig> | undefined;
  let keyPair: ReturnType<typeof keyPairFromSeed> | undefined;
  let deliver: ((packet: Buffer) => Promise<void>) | undefined;
  let endPackets!: () => void;
  const packetEnd = new Promise<void>((resolve) => { endPackets = resolve; });
  let deviceClosed!: (error: Error) => void;
  const closed = new Promise<Error>((resolve) => { deviceClosed = resolve; });
  let stopped: Promise<void> | undefined;
  let stopping = false;
  let timestamp = Date.now();
  const now = (): number => { timestamp = Math.max(timestamp, Date.now()); return timestamp; };
  const send = (value: object): Promise<void> => frames.send(IPC_CONTROL, Buffer.from(JSON.stringify(value)));
  setAcceptanceSink((event) => {
    frames.sendDiagnostic(Buffer.from(JSON.stringify({ type: "acceptance-diagnostic", event })));
  });
  const device: PacketDevice = {
    name: "packetFlow",
    packets: {
      send: async (packet) => { await frames.send(IPC_PACKET, packet); },
      receive: async (receiver) => { deliver = receiver; await packetEnd; },
    },
    closed,
    close: async () => { deliver = undefined; endPackets(); },
  };
  const shutdown = (): Promise<void> => {
    stopped ??= (async () => {
      state = "stopped";
      stopping = true;
      await startup;
      await runtime?.stop();
      deviceClosed(new Error("provider IPC closed"));
      endPackets();
      keyPair = undefined;
      setAcceptanceSink();
    })();
    return stopped;
  };
  async function control(payload: Buffer): Promise<void> {
    let message: unknown;
    try { message = JSON.parse(payload.toString("utf8")); }
    catch { throw new Error("invalid control message"); }
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid control message");
    const value = message as Record<string, unknown>;
    if (value.type === "pair" && state === "initial") {
      if (Object.keys(value).sort().join(",") !== "invitation,seed,type" || typeof value.invitation !== "string" || value.invitation.length > 256 ||
          typeof value.seed !== "string" || !/^[0-9a-f]{64}$/.test(value.seed)) throw new Error("invalid pairing message");
      state = "starting";
      keyPair = keyPairFromSeed(value.seed);
      try {
        const paired = await pair({ invitation: value.invitation, keyPair });
        await send({ type: "paired", address: paired.vpn!.address, receiverAddress: paired.vpn!.peers[0]!.address, receiverKey: paired.peers[0]!.publicKey });
      } catch (error) {
        await send({ type: "pair-error", reason: error instanceof PairError ? error.reason : "unknown" });
      }
      return;
    }
    if (value.type === "start" && state === "initial") {
      if (Object.keys(value).sort().join(",") !== "config,seed,type" || typeof value.config !== "string" ||
          typeof value.seed !== "string" || !/^[0-9a-f]{64}$/.test(value.seed)) throw new Error("invalid startup message");
      config = parseKeposConfig(value.config);
      if (!config.vpn) throw new Error("missing VPN configuration");
      keyPair = keyPairFromSeed(value.seed);
      const publicKey = Buffer.from(keyPair.publicKey).toString("hex");
      const peers = config.vpn.peers.map((entry) => {
        const peer = config!.peers.find((item) => item.label === entry.peer || item.publicKey === entry.peer)!;
        if (peer.publicKey === publicKey) throw new Error("self peer");
        return { publicKey: peer.publicKey, label: peer.label, address: entry.address, connected: false };
      });
      state = "settings";
      await send({ type: "settings", publicKey, address: config.vpn.address, peers });
      return;
    }
    if (value.type === "ready" && Object.keys(value).length === 1 && state === "settings") {
      state = "starting";
      startup = (async () => {
        const running = await startEngine({
          config: config!, keyPair: keyPair!, now,
          openTun: async () => device,
          onPeerStatus: ({ key, label, connected }) => {
            void send({ type: "peer", publicKey: key, label, connected }).catch(() => stream.destroy());
          },
        });
        runtime = running;
        if (stopping) return;
        state = "running";
        await send({ type: "running" });
        void running.failed.then(() => { if (!stopping) stream.destroy(); });
      })().catch(() => { stream.destroy(); });
      return;
    }
    if (value.type === "stop" && Object.keys(value).length === 1 && state !== "stopped") {
      await shutdown();
      await send({ type: "stopped" });
      return;
    }
    throw new Error("unexpected control message");
  }
  try {
    await frames.receive(async (kind, payload) => {
      if (kind === IPC_CONTROL) return control(payload);
      if (state !== "running" || !deliver || payload.length < 20 || payload.length > VPN_MTU) {
        throw new Error("unexpected packet");
      }
      await deliver(payload);
    });
  } catch {
    // Neither malformed local input nor transport failures are safe to echo.
    try { if (!stream.destroyed) await send({ type: "error" }); } catch { /* closed */ }
  } finally {
    await shutdown();
    stream.destroy();
  }
}
