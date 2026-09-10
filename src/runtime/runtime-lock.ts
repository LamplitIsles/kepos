import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { tryLock, unlock } from "fs-native-extensions";

export interface RuntimeLock {
  release: () => Promise<void>;
}

export interface AcquireRuntimeLockOptions {
  lockPath: string;
  conflictMessage: string;
  description?: string;
}

export function subscriberRuntimeLockPath(stateDir: string): string {
  const resolvedStateDir = path.resolve(stateDir);
  return path.join(
    path.dirname(resolvedStateDir),
    `.${path.basename(resolvedStateDir)}.subscriber.runtime.lock`,
  );
}

export function publisherRuntimeLockPath(stateDir: string): string {
  const resolvedStateDir = path.resolve(stateDir);
  return path.join(
    path.dirname(resolvedStateDir),
    `.${path.basename(resolvedStateDir)}.publisher.runtime.lock`,
  );
}

export async function acquireSubscriberRuntimeLock(
  stateDir: string,
): Promise<RuntimeLock> {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  return acquireRuntimeLock({
    lockPath: subscriberRuntimeLockPath(stateDir),
    conflictMessage: "Subscriber identity is already in use",
    description: "subscriber runtime lock",
  });
}

export async function acquirePublisherRuntimeLock(
  stateDir: string,
): Promise<RuntimeLock> {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  return acquireRuntimeLock({
    lockPath: publisherRuntimeLockPath(stateDir),
    conflictMessage: "Publisher identity is already in use",
    description: "publisher runtime lock",
  });
}

export async function acquireRuntimeLock(
  options: AcquireRuntimeLockOptions,
): Promise<RuntimeLock> {
  const { lockPath, conflictMessage } = options;
  const description = options.description ?? "runtime lock";
  await mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });

  let handle: FileHandle | undefined;
  let locked = false;
  try {
    // The path is intentionally stable. Kernel ownership belongs to this open
    // descriptor, not to the file contents or to the existence of the path.
    handle = await open(lockPath, "a+", 0o600);
    locked = tryLock(handle.fd);
    if (!locked) {
      const conflict = new Error(conflictMessage);
      const closeError = await closeHandle(handle, false, description);
      handle = undefined;
      if (closeError) throw combineErrors(conflict, closeError);
      throw conflict;
    }

    await handle.chmod(0o600);
    const ownedHandle = handle;
    handle = undefined;
    return runtimeLockForHandle(ownedHandle, description);
  } catch (error) {
    if (handle) {
      const closeError = await closeHandle(handle, locked, description);
      handle = undefined;
      if (closeError) throw combineErrors(error, closeError);
    }
    throw error;
  }
}

function runtimeLockForHandle(
  handle: FileHandle,
  description: string,
): RuntimeLock {
  let releasePromise: Promise<void> | undefined;

  return {
    release: () => {
      // Keep one promise for all callers. This makes concurrent shutdown paths
      // observe the same unlock/close result and prevents a second close.
      releasePromise ??= releaseHandle(handle, description);
      return releasePromise;
    },
  };
}

async function releaseHandle(
  handle: FileHandle,
  description: string,
): Promise<void> {
  const cleanupError = await closeHandle(handle, true, description);
  if (cleanupError) throw cleanupError;
}

async function closeHandle(
  handle: FileHandle,
  locked: boolean,
  description: string,
): Promise<Error | undefined> {
  let unlockError: unknown;
  if (locked) {
    try {
      unlock(handle.fd);
    } catch (error) {
      unlockError = error;
    }
  }

  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }

  if (unlockError && closeError) {
    return new AggregateError(
      [unlockError, closeError],
      `Failed to unlock and close ${description}`,
    );
  }
  if (unlockError) return asError(unlockError);
  if (closeError) return asError(closeError);
  return undefined;
}

function combineErrors(primary: unknown, cleanup: Error): Error {
  return new AggregateError(
    [asError(primary), cleanup],
    "Runtime lock cleanup failed",
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
