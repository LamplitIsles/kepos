import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import * as b4a from "b4a";
import crypto from "hypercore-crypto";

export interface RuntimeLockState {
  ownerToken: string;
  pid: number;
}

interface WritableFileHandle {
  write(buffer: Uint8Array): Promise<{ bytesWritten: number }>;
}

interface RuntimeLockFileHandle extends WritableFileHandle {
  close(): Promise<void>;
}

export interface RuntimeLockFileOperations {
  open(
    filePath: string,
    flags: string,
    mode: number,
  ): Promise<RuntimeLockFileHandle>;
  link(candidatePath: string, lockPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

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
  const ownerToken = b4a.toString(crypto.randomBytes(16), "hex");
  const state = { ownerToken, pid: process.pid };
  await removeOrphanedClaims(lockPath);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await createLock(lockPath, state);
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      let existing: RuntimeLockState;
      try {
        existing = await readLock(lockPath, description);
      } catch (readError) {
        if (!hasCauseCode(readError, "ENOENT")) throw readError;
        await waitForLockRetry(attempt, conflictMessage);
        continue;
      }
      if (pidIsAlive(existing.pid)) {
        throw new Error(`${conflictMessage} by process ${existing.pid}`);
      }
      if (await replaceStaleLock(lockPath, existing, state, description)) break;
      await waitForLockRetry(attempt, conflictMessage);
    }
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      const current = await readLock(lockPath, description);
      if (current.ownerToken !== ownerToken || current.pid !== process.pid) {
        throw new Error(`${description} ownership changed`);
      }
      await unlink(lockPath);
      released = true;
    },
  };
}

async function replaceStaleLock(
  lockPath: string,
  existing: RuntimeLockState,
  replacement: RuntimeLockState,
  description: string,
): Promise<boolean> {
  // The hard link captures the stale inode without first removing the
  // canonical lock. Only a claimant that owns the sole extra link may replace
  // it; a plain read/unlink/create sequence can delete a newer owner's lock.
  // PID and token make an interrupted claim identifiable on the next start.
  const claimPath = `${lockPath}.reclaim.${replacement.pid}.${replacement.ownerToken}`;

  try {
    await link(lockPath, claimPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }

  try {
    if (
      !(await ownsOnlyStaleClaim(
        lockPath,
        claimPath,
        existing,
        description,
      ))
    ) {
      return false;
    }

    await unlink(lockPath);
    try {
      await createLock(lockPath, replacement);
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
    return true;
  } finally {
    await unlink(claimPath).catch(() => undefined);
  }
}

async function ownsOnlyStaleClaim(
  lockPath: string,
  claimPath: string,
  existing: RuntimeLockState,
  description: string,
): Promise<boolean> {
  try {
    const claimed = await readLock(claimPath, description);
    const current = await readLock(lockPath, description);
    if (!sameLockState(claimed, existing) || !sameLockState(current, existing)) {
      return false;
    }
    const [claimedStat, currentStat] = await Promise.all([
      stat(claimPath),
      stat(lockPath),
    ]);
    return (
      claimedStat.dev === currentStat.dev &&
      claimedStat.ino === currentStat.ino &&
      claimedStat.nlink === 2
    );
  } catch (error) {
    if (hasCauseCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function waitForLockRetry(
  attempt: number,
  conflictMessage = "Subscriber identity is already in use",
): Promise<void> {
  if (attempt >= 15) {
    throw new Error(conflictMessage);
  }
  const maxDelayMs = Math.min(64, 2 ** attempt);
  const delayMs = 1 + (crypto.randomBytes(1)[0] % maxDelayMs);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function removeOrphanedClaims(lockPath: string): Promise<void> {
  // The PID is only a local liveness hint, not authentication. These owner-only
  // files sit beside the lock and are removed only after their process dies.
  const directory = path.dirname(lockPath);
  const names = await readdir(directory);
  for (const kind of ["create", "reclaim"]) {
    const prefix = `${path.basename(lockPath)}.${kind}.`;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const match = /^(\d+)\.[a-f0-9]{32}$/.exec(name.slice(prefix.length));
      if (match === null || pidIsAlive(Number(match[1]))) continue;
      await unlink(path.join(directory, name)).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }
  }
}

function sameLockState(
  left: RuntimeLockState,
  right: RuntimeLockState,
): boolean {
  return left.ownerToken === right.ownerToken && left.pid === right.pid;
}

async function createLock(
  lockPath: string,
  state: RuntimeLockState,
): Promise<void> {
  await installRuntimeLock(lockPath, state, { open, link, unlink });
}

export async function installRuntimeLock(
  lockPath: string,
  state: RuntimeLockState,
  operations: RuntimeLockFileOperations,
): Promise<void> {
  // bare-fs on Darwin does not currently preserve O_EXCL for open("wx"). A
  // hard link gives both Node and Bare one atomic winner without touching an
  // existing canonical lock.
  const candidatePath = `${lockPath}.create.${state.pid}.${state.ownerToken}`;
  const handle = await operations.open(candidatePath, "w", 0o600);
  try {
    try {
      await writeAll(handle, b4a.from(`${JSON.stringify(state)}\n`, "utf8"));
    } finally {
      await handle.close();
    }
    await operations.link(candidatePath, lockPath);
  } finally {
    await operations.unlink(candidatePath).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

export async function writeAll(
  handle: WritableFileHandle,
  buffer: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer.subarray(offset));
    if (bytesWritten <= 0) throw new Error("runtime lock write made no progress");
    offset += bytesWritten;
  }
}

async function readLock(
  lockPath: string,
  description: string,
): Promise<RuntimeLockState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot verify ${description}`, {
      cause: error,
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as Partial<RuntimeLockState>).ownerToken !== "string" ||
    !Number.isInteger((parsed as Partial<RuntimeLockState>).pid) ||
    ((parsed as Partial<RuntimeLockState>).pid ?? 0) <= 0
  ) {
    throw new Error(`Cannot verify ${description}`);
  }
  return parsed as RuntimeLockState;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function hasCauseCode(error: unknown, code: string): boolean {
  let current = error;
  while (current instanceof Error) {
    if (hasCode(current, code)) return true;
    current = current.cause;
  }
  return false;
}
