import path from "node:path";

import {
  loadKeposConfig,
  saveKeposConfig,
  type KeposConfig,
} from "../../../src/app-config.js";
import {
  parsePeerConfig,
  type PeerConfig,
} from "../../../src/config.js";
import type { PublisherRuntimePolicy } from "../../../src/runtime/publisher.js";
import type { SubscriberService } from "../../../src/runtime/subscriber.js";
import { ensureDesktopBootstrap, ensureDesktopPeerState } from "./bootstrap.js";
import { defaultDesktopPaths } from "./paths.js";
import type { Route } from "../../../src/mux/route.js";
import type { DhtAddress } from "../../../src/mux/hyperdht.js";
import type { ensurePublisher } from "../../../src/state/publisher.js";
import type { setupSubscriber } from "../../../src/state/subscriber.js";

export interface DesktopPeerOptions {
  stateDir: string;
  configPath?: string;
  config: PeerConfig;
}

/** Historical types remain available to the legacy desktop renderer only. */
export interface DesktopSubscriberSetup {
  configured: boolean;
  publicKey: string;
  error?: string;
}

/** @deprecated canonical desktop startup uses DesktopPeerOptions. */
export interface DesktopSubscriberOptions {
  stateDir: string;
  gatewayPort: number;
  subscriberSetup?: DesktopSubscriberSetup;
  gatewayHost?: string;
  gatewayDomain?: string;
  route?: Route;
  services: SubscriberService[];
}

/** @deprecated canonical desktop startup uses DesktopPeerOptions. */
export interface DesktopPublisherOptions {
  stateDir: string;
  configPath?: string;
  policy: PublisherRuntimePolicy;
}

export interface DesktopOptions {
  peer?: DesktopPeerOptions;
  bootstrap?: DhtAddress[];
  /** Legacy role options are not produced by the canonical reader. */
  publisher?: DesktopPublisherOptions;
  subscriber?: DesktopSubscriberOptions;
}

export interface DesktopConfigContext {
  homeDirectory: string;
  config?: KeposConfig;
  environment?: Record<string, string | undefined>;
  configPath?: string;
  platform?: NodeJS.Platform;
  ensurePublisher?: typeof ensurePublisher;
  setupSubscriber?: typeof setupSubscriber;
}

export interface LoadDesktopOptionsContext {
  homeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
  loadConfig?: typeof loadKeposConfig;
  saveConfig?: typeof saveKeposConfig;
  ensurePeer?: typeof import("../../../src/state/peer.js").ensurePeer;
  platform?: NodeJS.Platform;
  ensurePublisher?: typeof ensurePublisher;
  setupSubscriber?: typeof setupSubscriber;
}

export async function loadDesktopOptions(
  arguments_: readonly string[],
  context: LoadDesktopOptionsContext,
): Promise<DesktopOptions> {
  if (arguments_.length > 0 && (arguments_.length !== 2 || arguments_[0] !== "--config")) {
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
      peer: { stateDir: defaultDesktopPaths(context).peerStateDir, configPath, config },
      ...(config.network?.bootstrap ? { bootstrap: config.network.bootstrap } : {}),
    };
  }
  const bootstrapped = await ensureDesktopBootstrap(context);
  return {
    peer: {
      stateDir: defaultDesktopPaths(context).peerStateDir,
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
  return {
    peer: {
      stateDir: paths.peerStateDir,
      ...(context.configPath ? { configPath: context.configPath } : {}),
      config,
    },
    ...(config.network?.bootstrap ? { bootstrap: config.network.bootstrap } : {}),
  };
}
