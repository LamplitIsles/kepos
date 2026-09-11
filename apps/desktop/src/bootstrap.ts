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
import { ensurePeer, type SetupPeerResult } from "../../../src/state/peer.js";
import { parsePeerConfig, type PeerConfig } from "../../../src/config.js";
import { desktopBootstrapAssetPath, defaultDesktopPaths } from "./paths.js";

export interface DesktopBootstrapContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executablePath?: string;
  loadConfig?: typeof loadKeposConfig;
  readBootstrapAsset?: typeof readDesktopBootstrapAsset;
  saveConfig?: typeof saveKeposConfig;
  ensurePeer?: typeof ensurePeer;
}

export interface DesktopBootstrapResult {
  config: PeerConfig;
  configPath: string;
  peer: SetupPeerResult;
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
  const loaded = await (context.loadConfig ?? loadKeposConfig)(
    undefined,
    context.environment,
    context.homeDirectory,
    context.platform,
  );
  const peer = await (context.ensurePeer ?? ensurePeer)({
    stateDir: paths.peerStateDir,
  });
  if (loaded !== undefined) {
    return {
      config: parsePeerConfig(loaded),
      configPath: paths.configPath,
      peer,
    };
  }
  const bootstrap = await (context.readBootstrapAsset ?? readDesktopBootstrapAsset)(
    desktopBootstrapAssetPath(
      context.executablePath ?? process.execPath,
      context.platform,
    ),
  );
  const defaultConfig: PeerConfig = {
    ...(bootstrap ? { network: { bootstrap } } : {}),
    gateway: { port: DEFAULT_GATEWAY_PORT },
    peers: [],
    services: [],
    bindings: [],
  };
  await (context.saveConfig ?? saveKeposConfig)(defaultConfig, paths.configPath);
  return {
    config: defaultConfig,
    configPath: paths.configPath,
    peer,
  };
}

export async function ensureDesktopPeerState(
  config: KeposConfig,
  context: DesktopBootstrapContext,
): Promise<SetupPeerResult> {
  const parsed = parsePeerConfig(config);
  const paths = defaultDesktopPaths(context);
  return (context.ensurePeer ?? ensurePeer)({ stateDir: paths.peerStateDir });
}

/** @deprecated role state is no longer created by desktop startup. */
export const ensureDesktopRoleState = ensureDesktopPeerState;
