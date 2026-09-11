import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import { parsePeerConfig, type PeerConfig } from "../../../src/config.js";
import { defaultKeposConfigPath } from "../../../src/platform/paths.js";
import type { SubscriberDevice } from "../../../src/config.js";
import type { DesktopRuntimeConfiguration } from "./runtime.js";
import { parseDesktopOptions, type DesktopOptions } from "./options.js";

export interface ApplyDesktopConfigContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  configPath?: string;
  platform?: NodeJS.Platform;
  saveConfig?: typeof saveKeposConfig;
  reconfigure(configuration: DesktopRuntimeConfiguration): Promise<void>;
}
export async function applyDesktopConfig(
  config: PeerConfig,
  context: ApplyDesktopConfigContext,
): Promise<DesktopOptions> {
  const parsed = parsePeerConfig(config);
  const configPath =
    context.configPath ??
    defaultKeposConfigPath(
      context.environment,
      context.homeDirectory,
      context.platform,
    );
  const options = parseDesktopOptions([], {
    homeDirectory: context.homeDirectory,
    environment: context.environment,
    config: parsed,
    configPath,
    platform: context.platform,
  });
  await (context.saveConfig ?? saveKeposConfig)(parsed, configPath);
  await context.reconfigure({ peer: options.peer });
  return options;
}

/**
 * Role-owned subscriber persistence was part of the removed desktop model.
 * Keep the symbol for old renderer modules while making accidental use fail
 * explicitly instead of writing a hidden legacy table.
 */
export async function persistDesktopPublisherSubscribers(
  _configPath: string,
  _subscribers: SubscriberDevice[],
  _dependencies: {
    loadConfig?: typeof loadKeposConfig;
    saveConfig?: typeof saveKeposConfig;
  } = {},
): Promise<void> {
  throw new Error(
    "desktop publisher subscriber persistence was removed; use peer pair and service allowlists",
  );
}
