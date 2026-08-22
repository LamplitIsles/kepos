import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import { parseBootstrapAsset } from "../../../src/bootstrap-asset.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import { DEFAULT_GATEWAY_PORT } from "../../../src/home/gateway.js";
import {
  setupPublisher,
  type SetupPublisherResult,
} from "../../../src/state/publisher.js";
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
  readBootstrapAsset?: typeof readDesktopBootstrapAsset;
  saveConfig?: typeof saveKeposConfig;
  setupPublisher?: typeof setupPublisher;
  setupSubscriber?: typeof setupSubscriber;
}

export interface DesktopBootstrapResult {
  config: KeposConfig;
  configPath: string;
  publisher?: SetupPublisherResult;
  subscriber?: SetupSubscriberResult;
}

export async function readDesktopBootstrapAsset(
  assetPath: string,
): Promise<DhtAddress[] | undefined> {
  let source: string;
  try {
    source = await readFile(assetPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EACCES")
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    return parseDesktopBootstrapAsset(source);
  } catch {
    return undefined;
  }
}

export function parseDesktopBootstrapAsset(
  source: string,
): DhtAddress[] | undefined {
  try {
    return parseBootstrapAsset(source);
  } catch {
    throw new Error("invalid desktop bootstrap asset");
  }
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
    const bootstrap = await (context.readBootstrapAsset ?? readDesktopBootstrapAsset)(
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

  const publisher =
    config.publisher?.enabled === true
      ? await (context.setupPublisher ?? setupPublisher)({
          stateDir: paths.publisherStateDir,
          displayName: config.publisher.displayName,
          subscriberPublicKeys: config.publisher.allow,
          services: config.publisher.services,
        })
      : undefined;
  const subscriber =
    config.subscriber?.enabled === true
      ? await (context.setupSubscriber ?? setupSubscriber)({
          stateDir: paths.subscriberStateDir,
        })
      : undefined;
  return {
    config,
    configPath: paths.configPath,
    ...(publisher ? { publisher } : {}),
    ...(subscriber ? { subscriber } : {}),
  };
}
