import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { parseInvitation } from "../src/vpn/invitation.js";
import { InvitationExclusionError, ReceiverState } from "../src/vpn/receiver-state.js";
import { EnrollmentRejected } from "../src/vpn/enrollment-errors.js";
import { keyPairFromSeed } from "../src/mux/hyperdht.js";

const key = (): string => randomBytes(32).toString("hex");

test("an invitation excludes a conflicting address only for its new admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-exclusion-"));
  try {
    let now = 1_000_000;
    const options = { directory: path.join(root, "state"), receiverKey: key(), receiverAddress: "198.18.5.1", pool: "198.18.5.0/29", now: () => now };
    let state = await ReceiverState.open(options);
    const affectedKey = Buffer.from(keyPairFromSeed(key()).publicKey).toString("hex");
    const otherKey = Buffer.from(keyPairFromSeed(key()).publicKey).toString("hex");
    const affected = await state.enroll(affectedKey, parseInvitation(await state.createInvitation()).secret);
    const other = await state.enroll(otherKey, parseInvitation(await state.createInvitation()).secret);
    await state.grant(otherKey, [443]);
    await assert.rejects(state.createInvitation(affected.address), (e: unknown) => e instanceof InvitationExclusionError && e.reason === "allocated");
    for (const value of ["198.18.5.0", "198.18.5.1", "198.18.5.7", "198.18.6.2", "not-an-address"]) {
      await assert.rejects(state.createInvitation(value), (e: unknown) => e instanceof InvitationExclusionError && e.reason === "invalid");
    }
    await state.revoke(affectedKey);
    const text = await state.createInvitation(affected.address);
    const invite = parseInvitation(text);
    const disk = await readFile(path.join(options.directory, "receiver.json"), "utf8");
    assert(!disk.includes(text) && !disk.includes(invite.secret));
    state = await ReceiverState.open(options);
    await assert.rejects(state.enroll(affectedKey, key()), /unusable invitation/);
    const readmitted = await state.enroll(affectedKey, invite.secret);
    assert.equal(readmitted.address, "198.18.5.4");
    assert.deepEqual(await state.list(), [{ ...other, allowTcp: [443] }, readmitted]);
    await assert.rejects(state.enroll(key(), invite.secret), /unusable invitation/);
    const ordinary = parseInvitation(await state.createInvitation());
    assert.equal((await state.enroll(key(), ordinary.secret)).address, affected.address);
    const expiring = parseInvitation(await state.createInvitation("198.18.5.5"));
    now += 600_000;
    await assert.rejects(state.enroll(key(), expiring.secret), /unusable invitation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a racing allocation cannot re-pair with the excluded address or consume the invitation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-exclusion-race-"));
  try {
    const state = await ReceiverState.open({ directory: path.join(root, "state"), receiverKey: key(), receiverAddress: "198.18.5.1", pool: "198.18.5.0/29" });
    const recovery = parseInvitation(await state.createInvitation("198.18.5.2"));
    const racingKey = key();
    const first = await state.enroll(racingKey, parseInvitation(await state.createInvitation()).secret);
    assert.equal(first.address, "198.18.5.2");
    await state.grant(racingKey, [8443]);
    await assert.rejects(state.enroll(racingKey, recovery.secret), (e: unknown) => e instanceof EnrollmentRejected && e.reason === "excluded");
    assert.deepEqual(await state.list(), [{ ...first, allowTcp: [8443] }]);
    await state.revoke(racingKey);
    const results = await Promise.allSettled([state.enroll(racingKey, recovery.secret), state.enroll(key(), recovery.secret)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await state.list())[0]!.address, "198.18.5.3");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("excluding the last free address reports pool exhaustion without consuming the invitation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-exclusion-full-"));
  try {
    const state = await ReceiverState.open({ directory: path.join(root, "state"), receiverKey: key(), receiverAddress: "198.18.5.1", pool: "198.18.5.0/29" });
    const devices = [];
    for (let i = 0; i < 4; i++) devices.push(await state.enroll(key(), parseInvitation(await state.createInvitation()).secret));
    const invite = parseInvitation(await state.createInvitation("198.18.5.6"));
    const joining = key();
    await assert.rejects(state.enroll(joining, invite.secret), (e: unknown) => e instanceof EnrollmentRejected && e.reason === "pool");
    await state.revoke(devices[1]!.publicKey);
    assert.equal((await state.enroll(joining, invite.secret)).address, devices[1]!.address);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invitations are single use, bound to authenticated identities, and allocations persist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-receiver-"));
  try {
    let now = 1_000_000;
    const options = { directory: path.join(root, "state"), receiverKey: key(), receiverAddress: "198.18.5.1", pool: "198.18.5.0/29", now: () => now };
    let state = await ReceiverState.open(options);
    const invite = await state.createInvitation();
    const parsed = parseInvitation(invite);
    assert.equal(parsed.receiverKey, options.receiverKey);
    const firstKey = key(), secondKey = key();
    const attempts = await Promise.allSettled([state.enroll(firstKey, parsed.secret), state.enroll(secondKey, parsed.secret)]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    const first = (attempts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof state.enroll>>>).value;
    assert.equal(first.address, "198.18.5.2");
    assert.equal(first.allowTcp, "all");
    const disk = await readFile(path.join(options.directory, "receiver.json"), "utf8");
    assert(!disk.includes(invite));
    assert(!disk.includes(parsed.secret));
    await state.grant(first.publicKey, [443]);
    const retry = parseInvitation(await state.createInvitation());
    assert.deepEqual(await state.enroll(first.publicKey, retry.secret), { ...first, allowTcp: [443] });
    const newInvite = parseInvitation(await state.createInvitation());
    const second = await state.enroll(secondKey, newInvite.secret);
    assert.equal(second.address, "198.18.5.3");
    state = await ReceiverState.open(options);
    assert.deepEqual(await state.list(), [{ ...first, allowTcp: [443] }, second]);
    await assert.rejects(state.enroll(key(), newInvite.secret), /unusable invitation/);
    await state.revoke(first.publicKey);
    assert.deepEqual(await state.list(), [second]);
    now += 1;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("device capacity is a known pre-commit rejection and preserves the invitation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-receiver-capacity-"));
  try {
    const state = await ReceiverState.open({ directory: path.join(root, "state"), receiverKey: key(), receiverAddress: "198.18.5.1", pool: "198.18.5.0/24" });
    const keys: string[] = [];
    for (let index = 0; index < 16; index++) {
      const publicKey = Buffer.from(keyPairFromSeed(key()).publicKey).toString("hex");
      keys.push(publicKey);
      await state.enroll(publicKey, parseInvitation(await state.createInvitation()).secret);
    }
    const waiting = parseInvitation(await state.createInvitation());
    const next = Buffer.from(keyPairFromSeed(key()).publicKey).toString("hex");
    await assert.rejects(state.enroll(next, waiting.secret), (error: unknown) => error instanceof EnrollmentRejected && error.reason === "capacity");
    await state.revoke(keys[0]!);
    assert.equal((await state.enroll(next, waiting.secret)).publicKey, next);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("expired, invalid and exhausted enrollments do not consume other invitations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-receiver-"));
  try {
    let now = 1_000_000;
    const options = { directory: path.join(root, "state"), receiverKey: key(), receiverAddress: "198.18.6.1", pool: "198.18.6.0/30", now: () => now };
    const state = await ReceiverState.open(options);
    const expired = parseInvitation(await state.createInvitation());
    now += 600_000;
    await assert.rejects(state.enroll(key(), expired.secret), /unusable invitation/);
    const active = parseInvitation(await state.createInvitation());
    await assert.rejects(state.enroll(key(), key()), /unusable invitation/);
    const first = await state.enroll(key(), active.secret);
    assert.equal(first.address, "198.18.6.2");
    const waiting = parseInvitation(await state.createInvitation());
    const other = key();
    await assert.rejects(state.enroll(other, waiting.secret), /pool exhausted/);
    await state.revoke(first.publicKey);
    assert.equal((await state.enroll(other, waiting.secret)).address, first.address);
    await assert.rejects(ReceiverState.open({ ...options, pool: "198.18.7.0/24" }), /receiver state/);
    await unlink(path.join(options.directory, "receiver.json"));
    await assert.rejects(ReceiverState.open(options), /receiver state/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
