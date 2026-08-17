import path from "node:path";
import process from "node:process";

import {
  acquireRuntimeLock,
  type RuntimeLock,
} from "../../../src/runtime/runtime-lock.js";
import { defaultKeposStateRoot } from "../../../src/platform/paths.js";

export function desktopSingletonLockPath(
  homeDirectory: string,
  environment: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    defaultKeposStateRoot(environment, homeDirectory, platform),
    "desktop.runtime.lock",
  );
}

export function acquireDesktopSingleton(
  homeDirectory: string,
): Promise<RuntimeLock> {
  return acquireRuntimeLock({
    lockPath: desktopSingletonLockPath(homeDirectory),
    conflictMessage: "Kepos desktop is already running",
    description: "desktop runtime lock",
  });
}
