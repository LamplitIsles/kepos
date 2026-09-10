import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import {
  acquirePublisherRuntimeLock,
  acquireRuntimeLock,
  acquireSubscriberRuntimeLock,
  publisherRuntimeLockPath,
  subscriberRuntimeLockPath,
} from "../src/runtime/runtime-lock.js";

const repository = fileURLToPath(new URL("..", import.meta.url));
const childScript = fileURLToPath(
  new URL("./fixtures/runtime-lock-child.ts", import.meta.url),
);

test("runtime lock scopes preserve stable paths and inodes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-runtime-lock-"));
  const stateDir = path.join(root, "subscriber");
  const subscriberPath = subscriberRuntimeLockPath(stateDir);
  const publisherPath = publisherRuntimeLockPath(stateDir);
  const desktopPath = path.join(root, "desktop.runtime.lock");
  await mkdir(stateDir, { recursive: true });

  // Existing bytes, including a stale PID-shaped record, are not ownership.
  await writeFile(subscriberPath, '{"pid":1,"ownerToken":"stale"}\n', {
    mode: 0o600,
  });
  const original = await stat(subscriberPath);
  const subscriber = await acquireSubscriberRuntimeLock(stateDir);
  const claimed = await stat(subscriberPath);

  let publisher:
    Awaited<ReturnType<typeof acquirePublisherRuntimeLock>> | undefined;
  let desktop: Awaited<ReturnType<typeof acquireRuntimeLock>> | undefined;
  try {
    assert.equal(claimed.ino, original.ino);
    assert.equal(claimed.dev, original.dev);
    assert.equal(claimed.mode & 0o777, 0o600);
    assert.equal(path.dirname(subscriberPath), path.dirname(stateDir));
    assert.equal(
      path.basename(subscriberPath),
      `.${path.basename(stateDir)}.subscriber.runtime.lock`,
    );
    assert.equal(
      path.basename(publisherPath),
      `.${path.basename(stateDir)}.publisher.runtime.lock`,
    );

    await assert.rejects(
      () => acquireSubscriberRuntimeLock(stateDir),
      /Subscriber identity is already in use/,
    );

    // Subscriber, publisher, and desktop singleton scopes are independent.
    publisher = await acquirePublisherRuntimeLock(stateDir);
    desktop = await acquireRuntimeLock({
      lockPath: desktopPath,
      conflictMessage: "Kepos desktop is already running",
    });
    assert.equal((await stat(subscriberPath)).ino, original.ino);
    assert.equal((await stat(publisherPath)).mode & 0o777, 0o600);
    assert.equal((await stat(desktopPath)).mode & 0o777, 0o600);
  } finally {
    await desktop?.release().catch(() => undefined);
    await publisher?.release().catch(() => undefined);
    await subscriber.release().catch(() => undefined);
    assert.equal(
      (await stat(subscriberPath)).ino,
      original.ino,
      "release keeps the persistent lock inode",
    );
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(await pathExists(subscriberPath), false);
});

test("normal release is idempotent and concurrent callers share completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-runtime-release-"));
  const lockPath = path.join(root, "runtime.lock");
  const lock = await acquireRuntimeLock({
    lockPath,
    conflictMessage: "runtime lock is already owned",
  });

  try {
    const first = lock.release();
    const second = lock.release();
    assert.equal(first, second);
    await Promise.all([first, second, lock.release()]);

    const next = await acquireRuntimeLock({
      lockPath,
      conflictMessage: "runtime lock is already owned",
    });
    await next.release();
    assert.equal(await pathExists(lockPath), true);
  } finally {
    await lock.release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a live process excludes another process and normal shutdown permits reacquisition", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "kepos-runtime-cross-process-"),
  );
  const lockPath = path.join(root, "runtime.lock");
  const holder = startChild("hold", lockPath);

  try {
    await waitForOutput(holder, /^ready:\d+\n/u);
    await assert.rejects(
      () =>
        acquireRuntimeLock({
          lockPath,
          conflictMessage: "runtime lock is already owned",
        }),
      /runtime lock is already owned/,
    );

    await stopChild(holder.child, "SIGTERM");
    const next = await acquireRuntimeLock({
      lockPath,
      conflictMessage: "runtime lock is already owned",
    });
    await next.release();
  } finally {
    await stopChild(holder.child, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("a killed process releases the same persistent lock inode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-runtime-crash-"));
  const lockPath = path.join(root, "runtime.lock");
  const holder = startChild("hold", lockPath);

  try {
    await waitForOutput(holder, /^ready:\d+\n/u);
    const before = await stat(lockPath);
    await stopChild(holder.child, "SIGKILL");
    const afterDeath = await stat(lockPath);
    assert.equal(afterDeath.ino, before.ino);
    assert.equal(afterDeath.dev, before.dev);

    const replacement = await acquireRuntimeLock({
      lockPath,
      conflictMessage: "runtime lock is already owned",
    });
    await replacement.release();
    const afterReplacement = await stat(lockPath);
    assert.equal(afterReplacement.ino, before.ino);
    assert.equal(afterReplacement.dev, before.dev);
  } finally {
    await stopChild(holder.child, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("failed startup cleanup releases the runtime lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-runtime-startup-"));
  const lockPath = path.join(root, "runtime.lock");
  const lock = await acquireRuntimeLock({
    lockPath,
    conflictMessage: "runtime lock is already owned",
  });

  try {
    await assert.rejects(async () => {
      try {
        throw new Error("startup failed");
      } finally {
        await lock.release();
      }
    }, /startup failed/);
    const next = await acquireRuntimeLock({
      lockPath,
      conflictMessage: "runtime lock is already owned",
    });
    await next.release();
  } finally {
    await lock.release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed acquisitions close their attempted descriptors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-runtime-close-"));
  const lockPath = path.join(root, "runtime.lock");
  const owner = await acquireRuntimeLock({
    lockPath,
    conflictMessage: "runtime lock is already owned",
  });

  try {
    const before = await descriptorCount();
    for (let index = 0; index < 32; index += 1) {
      await assert.rejects(
        () =>
          acquireRuntimeLock({
            lockPath,
            conflictMessage: "runtime lock is already owned",
          }),
        /runtime lock is already owned/,
      );
    }
    const after = await descriptorCount();
    if (before !== undefined && after !== undefined) {
      assert.ok(after <= before + 1, `descriptor leak: ${before} -> ${after}`);
    }
  } finally {
    await owner.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("successive PID 1 namespaces exclude live owners and recover after SIGKILL", async (t) => {
  const namespace = pidNamespaceCommand(t);
  if (!namespace) return;

  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-runtime-pid1-"));
  const lockPath = path.join(root, "runtime.lock");
  const holder = startChild("hold", lockPath, namespace);
  let contender: StartedChild | undefined;

  try {
    await waitForOutput(holder, /^ready:1\n/u);
    const before = await stat(lockPath);

    contender = startChild("once", lockPath, namespace);
    const contenderExit = await waitForExit(contender.child);
    assert.equal(contenderExit.code, 1);
    assert.equal(contenderExit.signal, null);
    assert.match(contender.output.stderr, /runtime lock is already owned/);

    await stopChild(holder.child, "SIGKILL");
    const afterDeath = await stat(lockPath);
    assert.equal(afterDeath.ino, before.ino);
    assert.equal(afterDeath.dev, before.dev);

    const replacement = startChild("once", lockPath, namespace);
    const replacementOutput = await waitForOutput(
      replacement,
      /^acquired:1\nreleased:1\n/u,
    );
    assert.match(replacementOutput, /acquired:1\nreleased:1/);
    const replacementExit = await waitForExit(replacement.child);
    assert.equal(replacementExit.code, 0);
    assert.equal(replacementExit.signal, null);
  } finally {
    await stopChild(contender?.child, "SIGKILL");
    await stopChild(holder.child, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

interface StartedChild {
  child: ChildProcess;
  output: {
    stdout: string;
    stderr: string;
  };
}

function startChild(
  mode: "hold" | "once",
  lockPath: string,
  namespace?: string[],
): StartedChild {
  const command = namespace ? "unshare" : process.execPath;
  const arguments_ = namespace
    ? [
        ...namespace,
        "--kill-child",
        process.execPath,
        "--import",
        "tsx",
        childScript,
        mode,
        lockPath,
      ]
    : ["--import", "tsx", childScript, mode, lockPath];
  const child = spawn(command, arguments_, {
    cwd: repository,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  return { child, output };
}

async function waitForOutput(
  started: StartedChild,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = started.output.stdout.match(pattern);
    if (match) return match[0];
    if (started.child.exitCode !== null || started.child.signalCode !== null) {
      throw new Error(
        `child exited before ${pattern}: stdout=${started.output.stdout} stderr=${started.output.stderr}`,
      );
    }
    await delay(10);
  }
  throw new Error(
    `timed out waiting for ${pattern}: stdout=${started.output.stdout} stderr=${started.output.stderr}`,
  );
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("runtime lock child did not exit in time"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopChild(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await waitForExit(child).catch(() => undefined);
}

function pidNamespaceCommand(t: TestContext): string[] | undefined {
  if (process.platform !== "linux") {
    t.skip("PID namespaces are a Linux-specific regression");
    return undefined;
  }

  const candidates = [
    ["--pid", "--fork", "--mount-proc", "true"],
    ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "true"],
  ];
  for (const arguments_ of candidates) {
    const probe = spawnSync("unshare", arguments_, {
      encoding: "utf8",
      timeout: 3_000,
    });
    if (probe.status === 0) return arguments_.slice(0, -1);
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      t.skip("unshare is not installed on this host");
      return undefined;
    }
  }

  t.skip("this host does not permit the unshare PID-namespace facility");
  return undefined;
}

async function descriptorCount(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return (await readdir("/proc/self/fd")).length;
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
