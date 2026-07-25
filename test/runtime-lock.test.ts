import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquirePublisherRuntimeLock,
  acquireRuntimeLock,
  acquireSubscriberRuntimeLock,
  installRuntimeLock,
  publisherRuntimeLockPath,
  subscriberRuntimeLockPath,
  writeAll,
} from "../src/runtime/runtime-lock.js";

test("runtime lock writing supports Bare file handles and short writes", async () => {
  const chunks: Buffer[] = [];
  await writeAll(
    {
      async write(buffer) {
        const bytesWritten = Math.min(2, buffer.byteLength);
        chunks.push(Buffer.from(buffer.subarray(0, bytesWritten)));
        return { bytesWritten };
      },
    },
    Buffer.from("lock-state"),
  );

  assert.equal(Buffer.concat(chunks).toString(), "lock-state");
});

test("runtime lock installation relies on atomic link, not Bare exclusive open", async () => {
  const canonical = Buffer.from("existing-owner\n");
  const candidates = new Map<string, Buffer>();

  await assert.rejects(
    installRuntimeLock(
      "/state/runtime.lock",
      { ownerToken: "a".repeat(32), pid: 42 },
      {
        async open(filePath) {
          let bytes = Buffer.alloc(0);
          return {
            async write(buffer) {
              bytes = Buffer.concat([bytes, Buffer.from(buffer)]);
              candidates.set(filePath, bytes);
              return { bytesWritten: buffer.byteLength };
            },
            async close() {},
          };
        },
        async link(_candidatePath, lockPath) {
          assert.equal(lockPath, "/state/runtime.lock");
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        },
        async unlink(filePath) {
          candidates.delete(filePath);
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "EEXIST",
  );

  assert.equal(canonical.toString(), "existing-owner\n");
  assert.equal(candidates.size, 0);
});

test("allows only one host runtime for a subscriber state directory", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-lock-"));
  const first = await acquireSubscriberRuntimeLock(stateDir);

  try {
    assert.deepEqual(await readdir(stateDir), []);
    assert.equal(path.dirname(subscriberRuntimeLockPath(stateDir)), path.dirname(stateDir));
    await assert.rejects(
      () => acquireSubscriberRuntimeLock(stateDir),
      /subscriber identity is already in use/i,
    );
    await first.release();
    const next = await acquireSubscriberRuntimeLock(stateDir);
    await next.release();
  } finally {
    await first.release();
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("allows only one host runtime for a publisher state directory", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-publisher-lock-"));
  const lockPath = publisherRuntimeLockPath(stateDir);
  const first = await acquirePublisherRuntimeLock(stateDir);

  try {
    assert.equal(
      path.basename(lockPath),
      `.${path.basename(stateDir)}.publisher.runtime.lock`,
    );
    await assert.rejects(
      () => acquirePublisherRuntimeLock(stateDir),
      /publisher identity is already in use/i,
    );
    await first.release();
    const next = await acquirePublisherRuntimeLock(stateDir);
    await next.release();
  } finally {
    await first.release().catch(() => undefined);
    await rm(lockPath, { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a runtime lock can be reused for the desktop singleton", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-desktop-lock-"));
  const lockPath = path.join(directory, "desktop.runtime.lock");
  const first = await acquireRuntimeLock({
    lockPath,
    conflictMessage: "Kepos desktop is already running",
  });

  try {
    await assert.rejects(
      () =>
        acquireRuntimeLock({
          lockPath,
          conflictMessage: "Kepos desktop is already running",
        }),
      /desktop is already running/i,
    );
    await first.release();
    const next = await acquireRuntimeLock({
      lockPath,
      conflictMessage: "Kepos desktop is already running",
    });
    await next.release();
  } finally {
    await first.release().catch(() => undefined);
    await rm(lockPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("a runtime lock owner cannot delete a replacement lock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-lock-owner-"));
  const lockPath = path.join(directory, "desktop.runtime.lock");
  const lock = await acquireRuntimeLock({
    lockPath,
    conflictMessage: "Kepos desktop is already running",
  });
  await writeFile(
    lockPath,
    `${JSON.stringify({ ownerToken: "replacement", pid: process.pid })}\n`,
    { mode: 0o600 },
  );

  try {
    await assert.rejects(() => lock.release(), /ownership changed/i);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).ownerToken, "replacement");
  } finally {
    await rm(lockPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers a runtime lock owned by a dead process", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-stale-"));
  await writeFile(
    subscriberRuntimeLockPath(stateDir),
    `${JSON.stringify({ ownerToken: "stale", pid: 2_147_483_647 })}\n`,
    { mode: 0o600 },
  );

  try {
    const lock = await acquireSubscriberRuntimeLock(stateDir);
    await lock.release();
  } finally {
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("grants exactly one concurrent stale-lock claimant", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-stale-race-"));
  await writeFile(
    subscriberRuntimeLockPath(stateDir),
    `${JSON.stringify({ ownerToken: "stale", pid: 2_147_483_647 })}\n`,
    { mode: 0o600 },
  );

  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, () =>
        acquireSubscriberRuntimeLock(stateDir),
      ),
    );
    const acquired = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireSubscriberRuntimeLock>>
      > => attempt.status === "fulfilled",
    );

    assert.equal(acquired.length, 1);
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        assert.match(String(attempt.reason), /subscriber identity is already in use/i);
      }
    }
    await acquired[0].value.release();
  } finally {
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recovers after a stale-lock claimant crashes", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-claim-crash-"));
  const lockPath = subscriberRuntimeLockPath(stateDir);
  const orphanedClaim = `${lockPath}.reclaim.2147483647.${"a".repeat(32)}`;
  await writeFile(
    lockPath,
    `${JSON.stringify({ ownerToken: "stale", pid: 2_147_483_647 })}\n`,
    { mode: 0o600 },
  );
  await link(lockPath, orphanedClaim);

  try {
    const lock = await acquireSubscriberRuntimeLock(stateDir);
    await lock.release();
    assert.equal(
      (await readdir(path.dirname(lockPath))).includes(
        path.basename(orphanedClaim),
      ),
      false,
    );
  } finally {
    await rm(orphanedClaim, { force: true });
    await rm(lockPath, { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("fails closed for malformed runtime lock state", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-invalid-"));
  await writeFile(subscriberRuntimeLockPath(stateDir), "not-json\n", {
    mode: 0o600,
  });

  try {
    await assert.rejects(
      () => acquireSubscriberRuntimeLock(stateDir),
      /cannot verify subscriber runtime lock/i,
    );
  } finally {
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
