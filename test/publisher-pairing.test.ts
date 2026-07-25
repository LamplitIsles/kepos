import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PublisherPairing,
  type PairingCandidate,
} from "../src/pairing/publisher.js";
import { parsePairingInvitation } from "../src/pairing/invitation.js";

function candidate(
  token: string,
  events: string[],
  subscriberKey = "cd".repeat(32),
): PairingCandidate {
  return {
    subscriberKey,
    request: { token, label: "Neil's Pixel", platform: "android" },
    approve: () => events.push("approved"),
    deny: () => events.push("denied"),
    fail: (code) => events.push(`failed:${code}`),
  };
}

test("publisher pairing persists before activating one approved candidate", async () => {
  const now = 1_750_000_000_000;
  const events: string[] = [];
  const pairing = new PublisherPairing({
    publisherKey: "ab".repeat(32),
    displayName: "Kosmos",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    persistSubscriber: async (subscriberKey) => {
      assert.equal(subscriberKey, "cd".repeat(32));
      events.push("persisted");
    },
  });
  const invitation = pairing.createInvitation();
  const parsed = parsePairingInvitation(invitation.uri, { now: () => now });

  assert.equal(pairing.receive(candidate(parsed.token, events)), true);
  assert.deepEqual(pairing.snapshot(), {
    phase: "pending",
    subscriberKey: "cd".repeat(32),
    keyFingerprint: "cd".repeat(8),
    label: "Neil's Pixel",
    platform: "android",
  });

  await pairing.approve();
  assert.deepEqual(events, ["persisted", "approved"]);
  assert.deepEqual(pairing.snapshot(), { phase: "idle" });
  assert.equal(pairing.receive(candidate(parsed.token, events)), false);
  assert.deepEqual(events, [
    "persisted",
    "approved",
    "failed:invitation-unavailable",
  ]);
});

test("publisher pairing rejects invalid and competing requests", () => {
  const now = 1_750_000_000_000;
  const events: string[] = [];
  const pairing = new PublisherPairing({
    publisherKey: "ab".repeat(32),
    displayName: "Kosmos",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    persistSubscriber: async () => undefined,
  });
  const parsed = parsePairingInvitation(pairing.createInvitation().uri, {
    now: () => now,
  });

  assert.equal(
    pairing.receive(
      candidate(Buffer.alloc(32, 8).toString("base64url"), events),
    ),
    false,
  );
  assert.equal(pairing.receive(candidate(parsed.token, events)), true);
  assert.equal(
    pairing.receive(candidate(parsed.token, events, "ef".repeat(32))),
    false,
  );
  assert.deepEqual(events, [
    "failed:invalid-request",
    "failed:invitation-unavailable",
  ]);
});

test("publisher pairing keeps a candidate pending when persistence fails", async () => {
  const now = 1_750_000_000_000;
  const events: string[] = [];
  const pairing = new PublisherPairing({
    publisherKey: "ab".repeat(32),
    displayName: "Kosmos",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    persistSubscriber: async () => {
      throw new Error("disk full");
    },
  });
  const parsed = parsePairingInvitation(pairing.createInvitation().uri, {
    now: () => now,
  });
  pairing.receive(candidate(parsed.token, events));

  await assert.rejects(() => pairing.approve(), /disk full/);
  assert.equal(pairing.snapshot().phase, "pending");
  assert.deepEqual(events, []);
  pairing.deny();
  assert.deepEqual(events, ["denied"]);
});

test("publisher pairing exposes an in-flight approval for ordered shutdown", async () => {
  const now = 1_750_000_000_000;
  const events: string[] = [];
  let finishPersistence: (() => void) | undefined;
  const persistence = new Promise<void>((resolve) => {
    finishPersistence = resolve;
  });
  const pairing = new PublisherPairing({
    publisherKey: "ab".repeat(32),
    displayName: "Kosmos",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    persistSubscriber: async () => persistence,
  });
  const parsed = parsePairingInvitation(pairing.createInvitation().uri, {
    now: () => now,
  });
  pairing.receive(candidate(parsed.token, events));

  const approval = pairing.approve();
  let settled = false;
  const shutdownWait = pairing.waitForApproval().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  finishPersistence?.();
  await Promise.all([approval, shutdownWait]);
  assert.equal(settled, true);
  assert.deepEqual(events, ["approved"]);
});

test("publisher pairing expires and cancels invitations without retaining access", () => {
  let now = 1_750_000_000_000;
  const events: string[] = [];
  const pairing = new PublisherPairing({
    publisherKey: "ab".repeat(32),
    displayName: "Kosmos",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    persistSubscriber: async () => undefined,
  });
  const parsed = parsePairingInvitation(pairing.createInvitation().uri, {
    now: () => now,
  });

  now += 120_000;
  assert.equal(pairing.receive(candidate(parsed.token, events)), false);
  assert.deepEqual(events, ["failed:invitation-unavailable"]);

  now -= 120_000;
  const refreshed = parsePairingInvitation(pairing.createInvitation().uri, {
    now: () => now,
  });
  pairing.cancel();
  assert.equal(pairing.receive(candidate(refreshed.token, events)), false);
  assert.deepEqual(events, [
    "failed:invitation-unavailable",
    "failed:invitation-unavailable",
  ]);
});
