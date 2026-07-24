import path from "node:path";

import {
  acquireRuntimeLock,
  type SubscriberRuntimeLock,
} from "../../../src/runtime/subscriber-lock.js";

export function desktopSingletonLockPath(homeDirectory: string): string {
  return path.join(
    homeDirectory,
    ".local",
    "state",
    "kepos-neo",
    "desktop.runtime.lock",
  );
}

export function acquireDesktopSingleton(
  homeDirectory: string,
): Promise<SubscriberRuntimeLock> {
  return acquireRuntimeLock({
    lockPath: desktopSingletonLockPath(homeDirectory),
    conflictMessage: "Kepos desktop is already running",
    description: "desktop runtime lock",
  });
}
