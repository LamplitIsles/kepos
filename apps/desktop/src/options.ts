import path from "node:path";

import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import { parsePeerConfig, type PeerConfig } from "../../../src/config.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import { ensureDesktopBootstrap, ensureDesktopPeerState } from "./bootstrap.js";
import { defaultDesktopPaths } from "./paths.js";

export interface DesktopPeerOptions {
  stateDir: string;
  configPath: string;
  config: PeerConfig;
}

export interface DesktopOptions {
  peer: DesktopPeerOptions;
  bootstrap?: DhtAddress[];
}

export interface DesktopConfigContext {
  homeDirectory: string;
  config?: KeposConfig;
  environment?: Record<string, string | undefined>;
  configPath?: string;
  platform?: NodeJS.Platform;
}

export interface LoadDesktopOptionsContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  loadConfig?: typeof loadKeposConfig;
  saveConfig?: typeof saveKeposConfig;
  ensurePeer?: typeof import("../../../src/state/peer.js").ensurePeer;
  platform?: NodeJS.Platform;
}

export async function loadDesktopOptions(
  arguments_: readonly string[],
  context: LoadDesktopOptionsContext,
): Promise<DesktopOptions> {
  if (
    arguments_.length > 0 &&
    (arguments_.length !== 2 || arguments_[0] !== "--config")
  ) {
    throw new Error("desktop role flags were removed; edit canonical config.toml");
  }
  if (arguments_.length === 2) {
    const configPath = path.resolve(arguments_[1]!);
    const loaded = await (context.loadConfig ?? loadKeposConfig)(
      configPath,
      context.environment,
      context.homeDirectory,
      context.platform,
    );
    if (!loaded) throw new Error(`desktop config does not exist: ${configPath}`);
    const config = parsePeerConfig(loaded);
    const peer = await ensureDesktopPeerState(loaded, context);
    return {
      peer: { stateDir: peerStateDir(context), configPath, config },
      ...(config.network?.bootstrap ? { bootstrap: config.network.bootstrap } : {}),
    };
  }
  const bootstrapped = await ensureDesktopBootstrap(context);
  return {
    peer: {
      stateDir: peerStateDir(context),
      configPath: bootstrapped.configPath,
      config: bootstrapped.config,
    },
    ...(bootstrapped.config.network?.bootstrap
      ? { bootstrap: bootstrapped.config.network.bootstrap }
      : {}),
  };
}

export function parseDesktopOptions(
  arguments_: readonly string[],
  context?: DesktopConfigContext,
): DesktopOptions {
  if (arguments_.length > 0) {
    throw new Error("desktop role flags were removed; edit canonical config.toml");
  }
  if (!context?.config) throw new Error("desktop requires canonical config.toml");
  const config = parsePeerConfig(context.config);
  const paths = defaultDesktopPaths(context);
  const configPath = context.configPath ?? paths.configPath;
  return {
    peer: {
      stateDir: paths.peerStateDir,
      configPath,
      config,
    },
    ...(config.network?.bootstrap ? { bootstrap: config.network.bootstrap } : {}),
  };
}

function peerStateDir(context: LoadDesktopOptionsContext): string {
  return defaultDesktopPaths(context).peerStateDir;
}
