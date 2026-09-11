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
import type { PeerConfig } from "../../config.js";

const runtimeId = Bare.argv[0] ?? "runtime-unknown";
const stateDir = Bare.argv[1];
const configPath = Bare.argv[2];
if (!stateDir || !configPath) {
  throw new Error("Android peer state directory and config path are required");
}

const bootstrap = parseAndroidBootstrapAsset(Bare.argv[3] ?? "null");
const config = await loadOrCreateConfig(configPath, bootstrap);
await ensurePeer({ stateDir });

let running: RunningPeer | undefined = await startPeer({
  stateDir,
  config,
  persistConfig: (nextConfig) => saveKeposConfig(nextConfig, configPath),
});
let statusTimer: ReturnType<typeof setInterval> | undefined;

const status = (): Record<string, unknown> => {
  const current = running?.status();
  return current ? { ...current } : { state: "stopped" };
};

const controller = new WorkletController({
  runtimeId,
  echoUrl: running.gateway.url,
  write(frame) {
    BareKit.IPC.write(frame);
  },
  status,
  async stopEcho() {
    if (statusTimer !== undefined) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    const peer = running;
    running = undefined;
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
