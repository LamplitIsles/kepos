import { parsePeerConfig, type PeerConfig } from "../config.js";
import { createDht, type DhtKeyPair, type DhtNode, type DhtStream } from "../mux/hyperdht.js";
import { connectionOptionsForRoute } from "../mux/route.js";
import { PacketFraming } from "./framing.js";
import { enrollmentRequest, parseInvitation } from "./invitation.js";

export type PairFailure = "unusable" | "unavailable" | "unknown" | "capacity" | "pool" | "route" | "excluded";
export class PairError extends Error {
  constructor(readonly reason: PairFailure) { super(`pairing ${reason}`); }
}

/** Connect once. Once the request may have been sent, never replay it. */
export async function pairWithReceiver(options: { invitation: string; keyPair: DhtKeyPair; network?: PeerConfig["network"]; dht?: DhtNode }): Promise<PeerConfig> {
  let invitation: ReturnType<typeof parseInvitation>;
  try { invitation = parseInvitation(options.invitation); } catch { throw new PairError("unusable"); }
  const dht = options.dht ?? createDht({ keyPair: options.keyPair, bootstrap: options.network?.bootstrap });
  let stream: DhtStream | undefined;
  let submitted = false;
  try {
    stream = dht.connect(Buffer.from(invitation.receiverKey, "hex"), { keyPair: options.keyPair, ...connectionOptionsForRoute(options.network?.route ?? "auto") });
    const connection = stream;
    connection.on("error", () => undefined);
    return await new Promise<PeerConfig>((resolve, reject) => {
      let done = false;
      const finish = (error?: PairFailure, config?: PeerConfig): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        connection.destroy();
        if (error) reject(new PairError(error)); else resolve(config!);
      };
      const timer = setTimeout(() => finish(submitted ? "unknown" : "unavailable"), 20_000);
      const closed = (): void => finish(submitted ? "unknown" : "unavailable");
      connection.once("close", closed);
      connection.once("error", closed);
      const connected = (): void => {
        if (done) return;
        if (Buffer.from(connection.remotePublicKey).toString("hex") !== invitation.receiverKey) { finish("unavailable"); return; }
        const frames = new PacketFraming(connection);
        submitted = true;
        void frames.send(enrollmentRequest(invitation.secret)).then(async () => {
          await frames.receive(async (frame) => {
            // An already-authorized peer receives the ordinary VPN greeting.
            if (frame.equals(Buffer.from("Kepos VPN IPv4 v1\0\0\0", "ascii"))) return;
            let response: unknown;
            try { response = JSON.parse(frame.toString("utf8")) as unknown; } catch { finish("unknown"); return; }
            if (!response || typeof response !== "object" || Array.isArray(response)) { finish("unknown"); return; }
            const item = response as Record<string, unknown>;
            if (item.type === "unusable" && item.version === "1" && Object.keys(item).sort().join(",") === "type,version") { finish("unusable"); return; }
            if (item.type === "rejected" && item.version === "1" && Object.keys(item).sort().join(",") === "reason,type,version" &&
                (item.reason === "capacity" || item.reason === "pool" || item.reason === "route" || item.reason === "excluded")) { finish(item.reason); return; }
            if (item.type !== "accepted" || Object.keys(item).sort().join(",") !== "address,receiverAddress,receiverKey,type" || item.receiverKey !== invitation.receiverKey) { finish("unknown"); return; }
            try {
              const config = parsePeerConfig({ ...(options.network ? { network: options.network } : {}),
                peers: [{ label: "receiver", publicKey: invitation.receiverKey, connection: "dial" }],
                vpn: { address: item.address, peers: [{ peer: "receiver", address: item.receiverAddress, allowTcp: [] }] } });
              finish(undefined, config);
            } catch { finish("unknown"); }
          });
          if (!done) finish("unknown");
        }).catch(() => finish("unknown"));
      };
      connection.once("connect", connected);
      if (connection.connected) connected();
    });
  } catch (error) {
    if (error instanceof PairError) throw error;
    throw new PairError(submitted ? "unknown" : "unavailable");
  } finally {
    stream?.destroy();
    if (!options.dht) {
      try { await dht.destroy({ force: true }); } catch { /* Do not expose transport errors. */ }
    }
  }
}
