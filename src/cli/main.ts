import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Observation,
  Observe,
} from "../mux/observability.js";
import {
  startPublisher,
  type PublisherRuntimeStatus,
  type StartPublisherOptions,
} from "../runtime/publisher.js";
import {
  startSubscriber,
  type StartSubscriberOptions,
  type SubscriberRuntimeStatus,
} from "../runtime/subscriber.js";
import {
  startDevice,
  type StartDeviceOptions,
} from "../runtime/device.js";
import {
  getPublisherPublicKey,
  setPublisherAllowlist,
  setPublisherServices,
  setupPublisher,
  type SetPublisherAllowlistOptions,
  type SetPublisherServicesOptions,
  type SetupPublisherOptions,
  type SetupPublisherResult,
} from "../state/publisher.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
  type SetSubscriberPublisherOptions,
  type SetupSubscriberOptions,
  type SetupSubscriberResult,
} from "../state/subscriber.js";
import {
  observationMode,
  parseBootstrapOptions,
  parseGatewayPortOption,
  parseGatewayHostOption,
  parseGatewayDomainOption,
  parseOptions,
  parsePublisherService,
  parseRouteOption,
  parseSubscriberService,
  repeatedOption,
  requiredOption,
  requiredState,
  singleOption,
} from "./options.js";
import {
  acquirePublisherRuntimeLock,
  acquireSubscriberRuntimeLock,
  type RuntimeLock,
} from "../runtime/runtime-lock.js";
import { waitForSignal } from "./signals.js";
import {
  loadKeposConfig,
  type KeposConfig,
} from "../app-config.js";
import { HOME_REGISTRY_PATH } from "../home/registry.js";

interface CliPublisher {
  home: { url: string };
  publisherKey: string;
  applyPolicy?: (
    policy: NonNullable<KeposConfig["publisher"]>,
  ) => Promise<boolean>;
  status: () => PublisherRuntimeStatus;
  stop: () => Promise<void>;
}

interface CliSubscriber {
  home: { url: string };
  publisherKey: string;
  services: Array<{ id: string; port: number }>;
  status: () => SubscriberRuntimeStatus;
  stop: () => Promise<void>;
}

interface CliDevice {
  publisher?: CliPublisher;
  subscriber?: CliSubscriber;
  stop: () => Promise<void>;
}

export interface CliDependencies {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  loadConfig: (configPath?: string) => Promise<KeposConfig | undefined>;
  setupPublisher: (
    options: SetupPublisherOptions,
  ) => Promise<SetupPublisherResult>;
  setupSubscriber: (
    options: SetupSubscriberOptions,
  ) => Promise<SetupSubscriberResult>;
  setSubscriberPublisher: (
    options: SetSubscriberPublisherOptions,
  ) => Promise<string>;
  setPublisherAllowlist: (
    options: SetPublisherAllowlistOptions,
  ) => Promise<void>;
  setPublisherServices: (
    options: SetPublisherServicesOptions,
  ) => Promise<void>;
  getPublisherPublicKey: (stateDir: string) => Promise<string>;
  startPublisher: (
    options: StartPublisherOptions,
  ) => Promise<CliPublisher>;
  startSubscriber: (
    options: StartSubscriberOptions,
  ) => Promise<CliSubscriber>;
  startDevice: (options: StartDeviceOptions) => Promise<CliDevice>;
  acquireSubscriberRuntimeLock: (
    stateDir: string,
  ) => Promise<RuntimeLock>;
  acquirePublisherRuntimeLock: (
    stateDir: string,
  ) => Promise<RuntimeLock>;
  waitForSignal: (stop: () => Promise<void>) => Promise<void>;
  schedulePolicyReload: (
    callback: () => void,
    intervalMs: number,
  ) => () => void;
}

export function createDefaultCliDependencies(
  output: Partial<
    Pick<CliDependencies, "stdout" | "stderr">
  > = {},
): CliDependencies {
  return {
    stdout: output.stdout ?? console.log,
    stderr: output.stderr ?? console.error,
    loadConfig: loadKeposConfig,
    setupPublisher,
    setupSubscriber,
    setSubscriberPublisher,
    setPublisherAllowlist,
    setPublisherServices,
    getPublisherPublicKey,
    startPublisher,
    startSubscriber,
    startDevice,
    acquirePublisherRuntimeLock,
    acquireSubscriberRuntimeLock,
    waitForSignal,
    schedulePolicyReload: (callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);
      return () => clearInterval(timer);
    },
  };
}

const defaultDependencies = createDefaultCliDependencies();

const CLI_USAGE = [
  "Usage: kepos <command> [options]",
  "",
  "Commands:",
  "  setup publisher",
  "  setup subscriber",
  "  publisher set-allow",
  "  publisher set-services",
  "  publisher key",
  "  publisher run",
  "  subscriber set-publisher",
  "  subscriber run",
  "  device run",
].join("\n");

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
): Promise<void> {
  if (
    arguments_.length === 0 ||
    arguments_.includes("--help") ||
    arguments_.includes("-h")
  ) {
    dependencies.stdout(CLI_USAGE);
    return;
  }
  const [group, action, ...rest] = arguments_;
  if (group === "setup" && action === "publisher") {
    await setupPublisherCommand(rest, dependencies);
    return;
  }
  if (group === "setup" && action === "subscriber") {
    await setupSubscriberCommand(rest, dependencies);
    return;
  }
  if (group === "subscriber" && action === "set-publisher") {
    await setSubscriberPublisherCommand(rest, dependencies);
    return;
  }
  if (group === "publisher" && action === "set-allow") {
    await setPublisherAllowlistCommand(rest, dependencies);
    return;
  }
  if (group === "publisher" && action === "set-services") {
    await setPublisherServicesCommand(rest, dependencies);
    return;
  }
  if (group === "publisher" && action === "key") {
    await getPublisherPublicKeyCommand(rest, dependencies);
    return;
  }
  if (group === "publisher" && action === "run") {
    await runPublisherCommand(rest, dependencies);
    return;
  }
  if (group === "subscriber" && action === "run") {
    await runSubscriberCommand(rest, dependencies);
    return;
  }
  if (group === "device" && action === "run") {
    await runDeviceCommand(rest, dependencies);
    return;
  }
  throw new Error(
    `unknown command: ${arguments_.join(" ")}\n\n${CLI_USAGE}`,
  );
}

async function setupPublisherCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--display-name",
    "--allow",
    "--service",
    "--config",
  ]);
  const config = await dependencies.loadConfig(configPath(options));
  if (
    config?.publisher &&
    ["--display-name", "--allow", "--service"].some((name) =>
      options.has(name),
    )
  ) {
    throw new Error(
      "publisher policy is managed by TOML; remove CLI policy options",
    );
  }
  const displayName =
    singleOption(options, "--display-name") ?? config?.publisher?.displayName;
  if (!displayName) throw new Error("--display-name is required");
  const subscriberPublicKeys = options.has("--allow")
    ? repeatedOption(options, "--allow")
    : (config?.publisher?.allow ?? []);
  const services = options.has("--service")
    ? repeatedOption(options, "--service").map(parsePublisherService)
    : (config?.publisher?.services ?? []);
  const result = await dependencies.setupPublisher({
    stateDir: requiredState(options),
    displayName,
    subscriberPublicKeys,
    services,
  });
  dependencies.stdout(`Publisher key: ${result.publisherKey}`);
}

async function setupSubscriberCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, ["--state"]);
  const result = await dependencies.setupSubscriber({
    stateDir: requiredState(options),
  });
  dependencies.stdout(`Subscriber key: ${result.publicKey}`);
}

async function setSubscriberPublisherCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--label",
    "--publisher-key",
  ]);
  await dependencies.setSubscriberPublisher({
    stateDir: requiredState(options),
    label: requiredOption(options, "--label"),
    publisherKey: requiredOption(options, "--publisher-key"),
  });
  dependencies.stdout("Publisher contact updated");
}

async function setPublisherAllowlistCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--allow",
    "--config",
  ]);
  await rejectTomlPublisherPolicy(options, dependencies);
  await dependencies.setPublisherAllowlist({
    stateDir: requiredState(options),
    subscriberPublicKeys: repeatedOption(options, "--allow"),
  });
  dependencies.stdout("Publisher allowlist updated");
}

async function setPublisherServicesCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--service",
    "--config",
  ]);
  await rejectTomlPublisherPolicy(options, dependencies);
  await dependencies.setPublisherServices({
    stateDir: requiredState(options),
    services: repeatedOption(options, "--service").map(
      parsePublisherService,
    ),
  });
  dependencies.stdout("Publisher services updated");
}

async function getPublisherPublicKeyCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, ["--state"]);
  const publisherKey = await dependencies.getPublisherPublicKey(
    requiredState(options),
  );
  dependencies.stdout(`Publisher key: ${publisherKey}`);
}

async function rejectTomlPublisherPolicy(
  options: ReturnType<typeof parseOptions>,
  dependencies: CliDependencies,
): Promise<void> {
  const config = await dependencies.loadConfig(configPath(options));
  if (!config?.publisher) return;
  throw new Error("publisher policy is managed by TOML; edit the config file");
}

async function runPublisherCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--observations",
    "--bootstrap",
    "--config",
  ]);
  const mode = observationMode(options);
  const config = await dependencies.loadConfig(configPath(options));
  const stateDir = requiredState(options);
  const lock = await dependencies.acquirePublisherRuntimeLock(stateDir);
  let stopPolicyReload: (() => void) | undefined;
  let policyReloads = Promise.resolve();
  try {
    const running = await dependencies.startPublisher({
      stateDir,
      bootstrap: resolvedBootstrap(options, config),
      policy: config?.publisher,
      observe: observationWriter(mode, dependencies),
    });
    if (config?.publisher) {
      let polling = true;
      const pollPolicy = (): void => {
        if (!polling) return;
        policyReloads = policyReloads.then(async () => {
          try {
            const nextConfig = await dependencies.loadConfig(configPath(options));
            if (!nextConfig?.publisher) {
              throw new Error("publisher policy section is missing");
            }
            if (!running.applyPolicy) {
              throw new Error("publisher policy reload is unavailable");
            }
            await running.applyPolicy(nextConfig.publisher);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            dependencies.stderr(`Publisher policy reload failed: ${message}`);
          }
        });
      };
      const cancel = dependencies.schedulePolicyReload(pollPolicy, 1_000);
      stopPolicyReload = (): void => {
        polling = false;
        cancel();
      };
    }
    statusWriter(mode, dependencies)(
      `Publisher running: key=${running.publisherKey} registry=${running.home.url}${HOME_REGISTRY_PATH}`,
    );
    await dependencies.waitForSignal(running.stop);
  } finally {
    stopPolicyReload?.();
    await policyReloads;
    await lock.release();
  }
}

async function runSubscriberCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--service",
    "--gateway-port",
    "--gateway-host",
    "--gateway-domain",
    "--route",
    "--observations",
    "--bootstrap",
    "--config",
  ]);
  const mode = observationMode(options);
  const config = await dependencies.loadConfig(configPath(options));
  const services = options.has("--service")
    ? repeatedOption(options, "--service").map(parseSubscriberService)
    : (config?.subscriber?.services ?? []);
  if (new Set(services.map(({ id }) => id)).size !== services.length) {
    throw new Error("subscriber services must have unique ids");
  }
  const stateDir = requiredState(options);
  const lock = await dependencies.acquireSubscriberRuntimeLock(stateDir);
  try {
    const running = await dependencies.startSubscriber({
      stateDir,
      bootstrap: resolvedBootstrap(options, config),
      gatewayPort:
        parseGatewayPortOption(options) ?? config?.subscriber?.gatewayPort,
      gatewayHost:
        parseGatewayHostOption(options) ?? config?.subscriber?.gatewayHost,
      gatewayDomain:
        parseGatewayDomainOption(options) ?? config?.subscriber?.gatewayDomain,
      services,
      route: options.has("--route")
        ? parseRouteOption(options)
        : (config?.subscriber?.route ?? "auto"),
      observe: observationWriter(mode, dependencies),
      waitForPublisher: false,
    });
    statusWriter(mode, dependencies)(
      `Subscriber running: publisher=${running.publisherKey} registry=${running.home.url}${HOME_REGISTRY_PATH}`,
    );
    for (const service of running.services) {
      statusWriter(mode, dependencies)(
        `Local service: ${service.id}=127.0.0.1:${service.port}`,
      );
    }
    await dependencies.waitForSignal(running.stop);
  } finally {
    await lock.release();
  }
}

async function runDeviceCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--publisher-state",
    "--subscriber-state",
    "--subscriber-service",
    "--gateway-port",
    "--gateway-host",
    "--gateway-domain",
    "--route",
    "--observations",
    "--bootstrap",
    "--config",
  ]);
  const mode = observationMode(options);
  const config = await dependencies.loadConfig(configPath(options));
  const publisherState = resolvedState(options, "--publisher-state");
  const subscriberState = resolvedState(options, "--subscriber-state");
  if (!publisherState && !subscriberState) {
    throw new Error(
      "device run requires --publisher-state or --subscriber-state",
    );
  }
  if (
    !subscriberState &&
    [
      "--subscriber-service",
      "--gateway-port",
      "--gateway-host",
      "--gateway-domain",
      "--route",
    ].some((name) => options.has(name))
  ) {
    throw new Error("subscriber options require --subscriber-state");
  }
  const services = options.has("--subscriber-service")
    ? repeatedOption(options, "--subscriber-service").map(
        parseSubscriberService,
      )
    : (config?.subscriber?.services ?? []);
  if (new Set(services.map(({ id }) => id)).size !== services.length) {
    throw new Error("subscriber services must have unique ids");
  }
  const observe = observationWriter(mode, dependencies);
  const publisherLock = publisherState
    ? await dependencies.acquirePublisherRuntimeLock(publisherState)
    : undefined;
  let subscriberLock: RuntimeLock | undefined;
  try {
    subscriberLock = subscriberState
      ? await dependencies.acquireSubscriberRuntimeLock(subscriberState)
      : undefined;
    const running = await dependencies.startDevice({
      bootstrap: resolvedBootstrap(options, config),
      ...(publisherState
        ? {
            publisher: {
              stateDir: publisherState,
              policy: config?.publisher,
              observe,
            },
          }
        : {}),
      ...(subscriberState
        ? {
            subscriber: {
              stateDir: subscriberState,
              gatewayPort:
                parseGatewayPortOption(options) ??
                config?.subscriber?.gatewayPort,
              gatewayHost:
                parseGatewayHostOption(options) ??
                config?.subscriber?.gatewayHost,
              gatewayDomain:
                parseGatewayDomainOption(options) ??
                config?.subscriber?.gatewayDomain,
              services,
              route: options.has("--route")
                ? parseRouteOption(options)
                : (config?.subscriber?.route ?? "auto"),
              observe,
              waitForPublisher: false,
            },
          }
        : {}),
    });
    if (running.publisher) {
      statusWriter(mode, dependencies)(
        `Publisher running: key=${running.publisher.publisherKey} registry=${running.publisher.home.url}${HOME_REGISTRY_PATH}`,
      );
    }
    if (running.subscriber) {
      statusWriter(mode, dependencies)(
        `Subscriber running: publisher=${running.subscriber.publisherKey} registry=${running.subscriber.home.url}${HOME_REGISTRY_PATH}`,
      );
      for (const service of running.subscriber.services) {
        statusWriter(mode, dependencies)(
          `Local service: ${service.id}=127.0.0.1:${service.port}`,
        );
      }
    }
    await dependencies.waitForSignal(running.stop);
  } finally {
    await releaseRuntimeLocks(subscriberLock, publisherLock);
  }
}

function resolvedState(
  options: ReturnType<typeof parseOptions>,
  name: "--publisher-state" | "--subscriber-state",
): string | undefined {
  const value = singleOption(options, name);
  return value === undefined ? undefined : path.resolve(value);
}

async function releaseRuntimeLocks(
  ...locks: Array<RuntimeLock | undefined>
): Promise<void> {
  let firstError: unknown;
  for (const lock of locks) {
    if (!lock) continue;
    try {
      await lock.release();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function resolvedBootstrap(
  options: ReturnType<typeof parseOptions>,
  config: KeposConfig | undefined,
) {
  const bootstrap =
    parseBootstrapOptions(options) ?? config?.network?.bootstrap;
  return bootstrap && bootstrap.length > 0 ? bootstrap : undefined;
}

function configPath(
  options: ReturnType<typeof parseOptions>,
): string | undefined {
  const value = singleOption(options, "--config");
  return value === undefined ? undefined : path.resolve(value);
}

function observationWriter(
  mode: "human" | "ndjson",
  dependencies: CliDependencies,
): Observe {
  if (mode === "ndjson") {
    return (observation) =>
      dependencies.stdout(JSON.stringify(observation));
  }
  return (observation) =>
    dependencies.stdout(formatObservation(observation));
}

function statusWriter(
  mode: "human" | "ndjson",
  dependencies: CliDependencies,
): (line: string) => void {
  return mode === "ndjson" ? dependencies.stderr : dependencies.stdout;
}

function formatObservation(observation: Observation): string {
  const {
    component: _component,
    event,
    timestamp: _timestamp,
    ...fields
  } = observation;
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatObservationValue(value)}`)
    .join(" ");
  return `${event}${details ? ` ${details}` : ""}`;
}

function formatObservationValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
