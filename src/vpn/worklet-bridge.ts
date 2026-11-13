import type { Duplex } from "node:stream";
import { parseKeposConfig } from "../config-toml.js";
import { keyPairFromSeed } from "../mux/hyperdht.js";
import { VPN_MTU } from "./packet-policy.js";
import { startVpnEngine, type EngineStage, type PacketDevice } from "./engine.js";
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
  // Fixed label for the failure path, carried by the existing error message so
  // hosts can classify it. Never free text.
  let failureStage: EngineStage | "startup" | "running" | undefined;
  let diagnostics = false;
  // Report the fixed stage before the stream goes away: a queued send loses
  // the frame once the stream is destroyed. The wait is bounded so cleanup is
  // never held up and the original failure is never masked.
  const reportFailure = async (stage: EngineStage | "startup" | "running"): Promise<void> => {
    failureStage = stage;
    await Promise.race([
      send({ type: "error", stage }).catch(() => undefined),
      new Promise<void>((resolve) => { setTimeout(resolve, 250); }),
    ]);
  };
  let timestamp = Date.now();
  const now = (): number => { timestamp = Math.max(timestamp, Date.now()); return timestamp; };
  const send = (value: object): Promise<void> => frames.send(IPC_CONTROL, Buffer.from(JSON.stringify(value)));
  // Fixed labels, coalesced into one frame per burst and sent through the
  // best-effort diagnostic path: no normal queue slot, no extra event-loop
  // handle, and a burst of stages is not reduced to a single label.
  let diagStages: string[] = [];
  let diagScheduled = false;
  // Coalesced into one frame per burst, sent through the best-effort diagnostic
  // path: no normal queue slot and no normal-frame backpressure. The path drops
  // a frame while another is in flight, so a burst that arrives during an
  // in-flight diagnostic is lost; the backlog is capped so that never grows.
  const flushDiag = (): void => {
    if (diagStages.length === 0) return;
    const frame = Buffer.from(JSON.stringify({ type: "diag", stages: diagStages }));
    const sent = frames.canSendDiagnostic();
    if (sent) frames.sendDiagnostic(frame);
    // Keep the backlog when the diagnostic path is busy, so a later attempt
    // still reports every stage instead of silently dropping them.
    if (sent) diagStages = [];
  };
  setAcceptanceSink((event) => {
    frames.sendDiagnostic(Buffer.from(JSON.stringify({ type: "acceptance-diagnostic", event })));
  });
  const diag = (stage: string): void => {
    if (!diagnostics || diagStages.length >= 16) return;
    diagStages.push(stage);
    if (diagScheduled) return;
    diagScheduled = true;
    // Bounded retry: the diagnostic path refuses while a normal frame or a
    // previous diagnostic is in flight. A zero-delay tick is enough for the
    // write to settle; it stops as soon as the backlog is accepted.
    let attempts = 0;
    const retry = (): void => {
      flushDiag();
      if (diagStages.length === 0 || attempts++ >= 8) {
        diagScheduled = false;
        return;
      }
      setTimeout(retry, 0);
    };
    setTimeout(retry, 0);
  };
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
    // The host may ask for its own public key before pairing. The seed is used
    // only to derive it and is never echoed back.
    if (value.type === "identity" && state === "initial") {
      if (Object.keys(value).sort().join(",") !== "seed,type" || typeof value.seed !== "string" || !/^[0-9a-f]{64}$/.test(value.seed)) throw new Error("invalid identity message");
      const publicKey = Buffer.from(keyPairFromSeed(value.seed).publicKey).toString("hex");
      await send({ type: "identity", publicKey });
      return;
    }
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
      const keys = Object.keys(value).sort().join(",");
      if (keys !== "config,seed,type" && keys !== "caps,config,seed,type") throw new Error("invalid startup message");
      const caps = Array.isArray(value.caps) ? value.caps : [];
      // Only a host that asks for it receives these frames; other hosts never
      // opt in, so their protocol is unchanged.
      diagnostics = caps.includes("diag");
      if (typeof value.config !== "string" ||
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
      diag("settings-sent");
      flushDiag();
      return;
    }
    if (value.type === "ready" && Object.keys(value).length === 1 && state === "settings") {
      state = "starting";
      diag("ready");
      startup = (async () => {
        const running = await startEngine({
          config: config!, keyPair: keyPair!, now,
          openTun: async () => device,
          stage: (reached) => {
            // Cleanup labels are progress, not the failure boundary.
            if (reached !== "cleanup-begin" && reached !== "cleanup-end") failureStage = reached;
            diag(reached);
          },
          onPeerStatus: ({ key, label, connected }) => {
            void send({ type: "peer", publicKey: key, label, connected }).catch(() => stream.destroy());
          },
        });
        runtime = running;
        if (stopping) return;
        state = "running";
        await send({ type: "running" });
        flushDiag();
        void running.failed.then(() => {
          if (stopping) return;
          void reportFailure("running").then(() => stream.destroy());
        });
      })().catch(() => {
        // The last real boundary reached; "startup" only when none was hit.
        void reportFailure(failureStage ?? "startup").then(() => stream.destroy());
      });
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
    try {
      if (!stream.destroyed) await send(failureStage ? { type: "error", stage: failureStage } : { type: "error" });
    } catch { /* closed */ }
  } finally {
    await shutdown();
    stream.destroy();
  }
}
