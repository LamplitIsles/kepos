import { WorkletController } from "@lamplitisles/kepos-android-worklet/controller";
import { readHomeRegistry } from "../../runtime/registry-client.js";
import {
  AndroidRegistryState,
  createAndroidRegistrySnapshot,
} from "../services.js";
import type { RunningSubscriber } from "../../runtime/subscriber.js";
import { startSubscriber } from "../../runtime/subscriber.js";
import {
  loadSubscriberConnectionState,
  setSubscriberPublisher,
  setupSubscriber,
} from "../../state/subscriber.js";
import { parseAndroidBootstrapAsset } from "../bootstrap.js";
import { createAndroidSubscriberServices } from "./services.js";

const runtimeId = Bare.argv[0] ?? "runtime-unknown";
const stateDir = Bare.argv[1];
if (!stateDir) throw new Error("Android subscriber state directory is required");

const gatewayPort = Number(Bare.argv[2] ?? "17480");
const mihomoPort = Number(Bare.argv[3] ?? "17890");
const dshPort = Number(Bare.argv[4] ?? "13080");
const openClawPort = Number(Bare.argv[5] ?? "18789");
const bootstrap = parseAndroidBootstrapAsset(Bare.argv[6] ?? "null");
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
  throw new Error("Android gateway port is invalid");
}
if (
  !Number.isInteger(mihomoPort) ||
  mihomoPort < 1 ||
  mihomoPort > 65_535
) {
  throw new Error("Android Mihomo port is invalid");
}
if (!Number.isInteger(dshPort) || dshPort < 1 || dshPort > 65_535) {
  throw new Error("Android dsh port is invalid");
}
if (
  !Number.isInteger(openClawPort) ||
  openClawPort < 1 ||
  openClawPort > 65_535
) {
  throw new Error("Android OpenClaw port is invalid");
}
const navidromeUrl = `http://navidrome.localhost:${gatewayPort}/`;
const subscriberServices = createAndroidSubscriberServices(
  mihomoPort,
  dshPort,
  openClawPort,
);
const localPorts = new Map(
  subscriberServices.map(({ id, localPort }) => [id, localPort]),
);
const setup = await setupSubscriber({ stateDir });
const initialConnectionState = setup.configured
  ? await loadSubscriberConnectionState(stateDir)
  : undefined;
const registry = new AndroidRegistryState();
let configured = setup.configured;
let connection: "offline" | "connecting" = "offline";
let connectionError: string | undefined;
let pairingConnection:
  | "pairing-connecting"
  | "awaiting-approval"
  | undefined = initialConnectionState?.pending
    ? "awaiting-approval"
    : undefined;
let running: RunningSubscriber | undefined;
let connectTask: Promise<void> | undefined;
let registryTask: Promise<void> | undefined;
let registryGeneration = 0;

const status = (): Record<string, unknown> => {
  const currentConnection = connectionError
    ? "offline"
    : pairingConnection
      ? pairingConnection
    : running?.status().connection ?? connection;
  registry.observeConnection(currentConnection);
  const known = registry.snapshot();
  return {
    subscriberPublicKey: setup.publicKey,
    configured: configured && connectionError === undefined,
    connection: currentConnection,
    ...(connectionError ? { error: connectionError } : {}),
    ...(known ?? {}),
  };
};

const refreshRegistry = (): void => {
  const currentConnection = running?.status().connection ?? connection;
  registry.observeConnection(currentConnection);
  if (!registry.shouldRefresh(currentConnection) || registryTask) return;
  const generation = registryGeneration;
  registryTask = readHomeRegistry(gatewayPort)
    .then((loaded) => {
      if (generation !== registryGeneration) return;
      registry.accept(
        createAndroidRegistrySnapshot(loaded, gatewayPort, localPorts),
      );
      controller.publishStatus();
    })
    .catch(() => undefined)
    .finally(() => {
      registryTask = undefined;
    });
};

const connect = (): void => {
  if (!configured || running || connectTask) return;
  connection = "connecting";
  connectTask = startSubscriber({
    stateDir,
    gatewayPort,
    bootstrap,
    services: subscriberServices,
    waitForPublisher: false,
  })
    .then((started) => {
      running = started;
    })
    .catch((error) => {
      connection = "offline";
      console.error("Kepos subscriber connection failed", error);
    })
    .finally(() => {
      connectTask = undefined;
    });
};

const controller = new WorkletController({
  runtimeId,
  echoUrl: navidromeUrl,
  status,
  write(frame) {
    BareKit.IPC.write(frame);
  },
  async configurePublisher(publisherKey) {
    connectionError = undefined;
    pairingConnection = undefined;
    registryGeneration++;
    registry.clear();
    await connectTask;
    await running?.stop();
    running = undefined;
    await setSubscriberPublisher({
      stateDir,
      label: "publisher",
      publisherKey,
    });
    configured = true;
    connect();
    return status();
  },
  async pairPublisher(invitation, deviceLabel, platform) {
    if (configured) {
      const current = await loadSubscriberConnectionState(stateDir);
      if (!current.pending) {
        throw new Error("Subscriber already has an approved publisher");
      }
    }
    registryGeneration++;
    registry.clear();
    connectionError = undefined;
    pairingConnection = "pairing-connecting";
    await connectTask;
    await running?.stop();
    running = undefined;
    configured = false;
    connection = "connecting";
    try {
      running = await startSubscriber({
        stateDir,
        gatewayPort,
        bootstrap,
        services: subscriberServices,
        pairing: {
          invitation,
          deviceLabel,
          platform,
          onStatus(status) {
            pairingConnection =
              status === "awaiting-approval" ? status : undefined;
            if (status === "awaiting-approval") controller.publishStatus();
          },
        },
        onTerminalConnectionError(error) {
          connection = "offline";
          connectionError = error.message;
          pairingConnection = undefined;
          controller.publishStatus();
        },
        waitForPublisher: false,
      });
      configured = true;
      return status();
    } catch (error) {
      connection = "offline";
      connectionError = error instanceof Error ? error.message : String(error);
      pairingConnection = undefined;
      configured = (await setupSubscriber({ stateDir })).configured;
      throw error;
    }
  },
  async stopEcho() {
    clearInterval(statusTimer);
    registryGeneration++;
    await connectTask;
    await running?.stop();
    running = undefined;
    connection = "offline";
    pairingConnection = undefined;
  },
});

const statusTimer = setInterval(() => {
  refreshRegistry();
  controller.publishStatus();
}, 1_000);

BareKit.IPC.on("data", (data) => {
  void controller.receive(data).catch((error) => {
    console.error("Kepos Worklet control failure", error);
  });
});

controller.start();
connect();
