import { WorkletController } from "@lamplitisles/kepos-android-worklet/controller";
import {
  loadKeposConfig,
  saveKeposConfig,
} from "../../app-config.js";
import { DEFAULT_GATEWAY_PORT } from "../../home/gateway.js";
import type { DhtAddress } from "../../mux/hyperdht.js";
import { startPeer, type RunningPeer } from "../../runtime/peer.js";
import { ensurePeer } from "../../state/peer.js";
import { parseAndroidBootstrapAsset } from "../bootstrap.js";
import { parsePeerConfig, type PeerConfig } from "../../config.js";

const runtimeId = Bare.argv[0] ?? "runtime-unknown";
const stateDir = Bare.argv[1];
const configPath = Bare.argv[2];
if (!stateDir || !configPath) {
  throw new Error("Android peer state directory and config path are required");
}

const bootstrap = parseAndroidBootstrapAsset(Bare.argv[3] ?? "null");
let config = await loadOrCreateConfig(configPath, bootstrap);
await ensurePeer({ stateDir });

const persistConfig = async (nextConfig: PeerConfig): Promise<void> => {
  await saveKeposConfig(nextConfig, configPath);
  config = nextConfig;
};

let running: RunningPeer | undefined = await startPeer({
  stateDir,
  config,
  persistConfig,
});
let statusTimer: ReturnType<typeof setInterval> | undefined;
let pairingConnection: "pairing-connecting" | "awaiting-approval" | undefined;

const status = (): Record<string, unknown> => {
  const current = running?.status();
  if (!current) return { state: "stopped" };
  const configuredPeer = config.peers[0];
  const connection = current.connections.find(
    ({ publicKey }) => publicKey === configuredPeer?.publicKey,
  );
  return {
    ...current,
    configured: configuredPeer !== undefined,
    connection: pairingConnection ?? connection?.status ?? "offline",
    ...(connection?.error ? { error: connection.error } : {}),
  };
};

const controller = new WorkletController({
  runtimeId,
  echoUrl: running.gateway.url,
  write(frame) {
    BareKit.IPC.write(frame);
  },
  status,
  async configurePeer(publicKey, label, connection) {
    const nextConfig = parsePeerConfig({
      ...config,
      peers: [{ label, publicKey, connection }],
      // Selecting a trusted peer must not silently retarget old forwarding
      // policy. Those services and bindings are operator-owned config.
      services: [],
      bindings: [],
    });
    if (!running) throw new Error("peer runtime is unavailable");
    pairingConnection = undefined;
    await persistConfig(nextConfig);
    await running.applyConfig(nextConfig);
    controller.publishStatus();
    return status();
  },
  async pairPeer(invitation, deviceLabel, platform) {
    if (!running) throw new Error("peer runtime is unavailable");
    pairingConnection = "pairing-connecting";
    controller.publishStatus();
    try {
      const result = await running.pair(invitation, deviceLabel, platform);
      pairingConnection = undefined;
      controller.publishStatus();
      return result;
    } catch (error) {
      pairingConnection = undefined;
      controller.publishStatus();
      throw error;
    }
  },
  async stopEcho() {
    if (statusTimer !== undefined) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    const peer = running;
    running = undefined;
    pairingConnection = undefined;
    await peer?.stop();
  },
});

BareKit.IPC.on("data", (data) => {
  void controller.receive(data).catch((error) => {
    console.error("Kepos peer Worklet control failure", error);
  });
});

statusTimer = setInterval(() => controller.publishStatus(), 1_000);
controller.start();

async function loadOrCreateConfig(
  path: string,
  bootstrap: DhtAddress[] | undefined,
): Promise<PeerConfig> {
  try {
    return (await loadKeposConfig(path)) ?? emptyConfig(bootstrap);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const created = emptyConfig(bootstrap);
    await saveKeposConfig(created, path);
    return created;
  }
}

function emptyConfig(bootstrap: DhtAddress[] | undefined): PeerConfig {
  return {
    ...(bootstrap ? { network: { bootstrap } } : {}),
    gateway: { port: DEFAULT_GATEWAY_PORT },
    peers: [],
    services: [],
    bindings: [],
  };
}

function isMissingFile(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return true;
  }
  return error.cause !== undefined && isMissingFile(error.cause);
}
