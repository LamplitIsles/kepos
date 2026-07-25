import { WorkletController } from "@tta-lab/kepos-android-worklet/controller";
import { readHomeRegistry } from "../../runtime/registry-client.js";
import {
  AndroidRegistryState,
  createAndroidRegistrySnapshot,
} from "../services.js";
import type { RunningSubscriber } from "../../runtime/subscriber.js";
import { startSubscriber } from "../../runtime/subscriber.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
} from "../../state/subscriber.js";
import { parseAndroidBootstrapAsset } from "../bootstrap.js";

const runtimeId = Bare.argv[0] ?? "runtime-unknown";
const stateDir = Bare.argv[1];
if (!stateDir) throw new Error("Android subscriber state directory is required");

const gatewayPort = Number(Bare.argv[2] ?? "17480");
const navidromePort = Number(Bare.argv[3] ?? "17481");
const bootstrap = parseAndroidBootstrapAsset(Bare.argv[4] ?? "null");
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
  throw new Error("Android gateway port is invalid");
}
if (
  !Number.isInteger(navidromePort) ||
  navidromePort < 1 ||
  navidromePort > 65_535
) {
  throw new Error("Android Navidrome port is invalid");
}
const navidromeUrl = `http://navidrome.localhost:${gatewayPort}/`;
const setup = await setupSubscriber({ stateDir });
const registry = new AndroidRegistryState();
let configured = setup.configured;
let connection: "offline" | "connecting" = "offline";
let running: RunningSubscriber | undefined;
let connectTask: Promise<void> | undefined;
let registryTask: Promise<void> | undefined;
let registryGeneration = 0;

const status = (): Record<string, unknown> => {
  const currentConnection = running?.status().connection ?? connection;
  registry.observeConnection(currentConnection);
  const known = registry.snapshot();
  return {
    subscriberPublicKey: setup.publicKey,
    configured,
    connection: currentConnection,
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
        createAndroidRegistrySnapshot(loaded, gatewayPort),
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
    services: [{ id: "navidrome", localPort: navidromePort }],
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
  async stopEcho() {
    clearInterval(statusTimer);
    registryGeneration++;
    await connectTask;
    await running?.stop();
    running = undefined;
    connection = "offline";
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
