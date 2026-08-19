import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import { DEFAULT_GATEWAY_PORT } from "../../../src/home/gateway.js";
import {
  setupSubscriber,
  type SetupSubscriberResult,
} from "../../../src/state/subscriber.js";
import { desktopBootstrapAssetPath, defaultDesktopPaths } from "./paths.js";

const defaultSubscriberSection: NonNullable<KeposConfig["subscriber"]> = {
  enabled: true,
  gatewayPort: DEFAULT_GATEWAY_PORT,
  services: [],
};

export interface DesktopBootstrapContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executablePath?: string;
  loadConfig?: typeof loadKeposConfig;
  saveConfig?: typeof saveKeposConfig;
  setupSubscriber?: typeof setupSubscriber;
}

export interface DesktopBootstrapResult {
  config: KeposConfig;
  configPath: string;
  subscriber?: SetupSubscriberResult;
}

export async function readDesktopBootstrapAsset(
  assetPath: string,
): Promise<DhtAddress[] | undefined> {
  try {
    return parseDesktopBootstrapAsset(await readFile(assetPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid desktop bootstrap asset") {
      return undefined;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export function parseDesktopBootstrapAsset(
  source: string,
): DhtAddress[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("invalid desktop bootstrap asset");
  }
  if (value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("invalid desktop bootstrap asset");
  }
  return value.map((endpoint) => {
    if (
      endpoint === null ||
      typeof endpoint !== "object" ||
      Object.keys(endpoint).length !== 2 ||
      !("host" in endpoint) ||
      typeof endpoint.host !== "string" ||
      endpoint.host.length === 0 ||
      !("port" in endpoint) ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65_535
    ) {
      throw new Error("invalid desktop bootstrap asset");
    }
    return { host: endpoint.host, port: endpoint.port };
  });
}

export async function ensureDesktopBootstrap(
  context: DesktopBootstrapContext,
): Promise<DesktopBootstrapResult> {
  const paths = defaultDesktopPaths(context);
  const config = await (context.loadConfig ?? loadKeposConfig)(
    undefined,
    context.environment,
    context.homeDirectory,
    context.platform,
  );
  if (config === undefined) {
    const bootstrap = await readDesktopBootstrapAsset(
      desktopBootstrapAssetPath(
        context.executablePath ?? process.execPath,
        context.platform,
      ),
    );
    const subscriber = await (context.setupSubscriber ?? setupSubscriber)({
      stateDir: paths.subscriberStateDir,
    });
    const defaultConfig: KeposConfig = {
      ...(bootstrap ? { network: { bootstrap } } : {}),
      subscriber: defaultSubscriberSection,
    };
    await (context.saveConfig ?? saveKeposConfig)(
      defaultConfig,
      paths.configPath,
    );
    return {
      config: defaultConfig,
      configPath: paths.configPath,
      subscriber,
    };
  }

  const subscriber =
    config.subscriber?.enabled === true
      ? await (context.setupSubscriber ?? setupSubscriber)({
          stateDir: paths.subscriberStateDir,
        })
      : undefined;
  return {
    config,
    configPath: paths.configPath,
    ...(subscriber ? { subscriber } : {}),
  };
}
