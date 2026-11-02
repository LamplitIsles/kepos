import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setupPeer, loadPeerIdentity } from "../src/state/peer.js";
import { keyPairFromSeed, type DhtNode, type DhtStream } from "../src/mux/hyperdht.js";
import { ReceiverState } from "../src/vpn/receiver-state.js";
import { startVpnEngine } from "../src/vpn/engine.js";
import { pairWithReceiver } from "../src/vpn/pair.js";
import { formatInvitation } from "../src/vpn/invitation.js";
import { randomBytes } from "node:crypto";
import { EnrollmentRejected, type EnrollmentRejection } from "../src/vpn/enrollment-errors.js";

class Linked extends Duplex {
  other?: Linked;
  connected = true;
  remotePublicKey: Buffer;
  constructor(key: Uint8Array) { super(); this.remotePublicKey = Buffer.from(key); }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (!this.other || this.other.destroyed) { cb(new Error("closed")); return; }
    this.other.push(Buffer.from(chunk)); cb();
  }
  override _final(cb: (error?: Error | null) => void): void { this.other?.push(null); cb(); }
  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    const other = this.other; this.other = undefined;
    if (other && !other.destroyed) other.destroy();
    cb(error);
  }
}

for (const transport of ["linked", "noise"] as const) test(`authenticated ${transport} stream enrolls once and cannot send VPN packets`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-enroll-"));
  let running: Awaited<ReturnType<typeof startVpnEngine>> | undefined;
  try {
    const receiverDir = path.join(root, "receiver"), dialerDir = path.join(root, "dialer");
    const receiverKey = (await setupPeer({ stateDir: receiverDir })).publicKey;
    await setupPeer({ stateDir: dialerDir });
    const receiver = keyPairFromSeed((await loadPeerIdentity(receiverDir)).seed);
    const dialer = keyPairFromSeed((await loadPeerIdentity(dialerDir)).seed);
    const store = await ReceiverState.open({ directory: path.join(root, "managed"), receiverKey, receiverAddress: "198.18.8.1", pool: "198.18.8.0/29" });
    let firewall!: (key: Uint8Array) => boolean;
    let accept!: (stream: DhtStream) => void;
    const server = { createServer: (options: { firewall: (key: Uint8Array) => boolean }, callback: (stream: DhtStream) => void) => {
      firewall = options.firewall; accept = callback;
      return { listen: async () => {}, close: async () => {} };
    }, destroy: async () => {} } as unknown as DhtNode;
    const client = { connect: (_key: Uint8Array, options: { keyPair: typeof dialer }) => {
      if (transport === "noise") {
        const require = createRequire(import.meta.url);
        const NoiseWrap = require("hyperdht/lib/noise-wrap");
        const SecretStream = require("@hyperswarm/secret-stream");
        const initiator = new NoiseWrap(options.keyPair, receiver.publicKey);
        const responder = new NoiseWrap(receiver, null);
        const payload = { error: 0, firewall: 0 };
        responder.recv(initiator.send(payload));
        initiator.recv(responder.send(payload));
        const a = new SecretStream(true, null, { autoStart: false });
        const b = new SecretStream(false, null, { autoStart: false });
        a.start(null, { handshake: initiator.final() });
        b.start(null, { handshake: responder.final() });
        a.rawStream.pipe(b.rawStream).pipe(a.rawStream);
        queueMicrotask(() => { if (firewall(options.keyPair.publicKey)) b.destroy(); else accept(b as DhtStream); });
        return a as DhtStream;
      }
      const a = new Linked(receiver.publicKey), b = new Linked(options.keyPair.publicKey); a.other = b; b.other = a;
      queueMicrotask(() => { if (firewall(options.keyPair.publicKey)) b.destroy(); else accept(b as DhtStream); });
      return a as DhtStream;
    }, destroy: async () => {} } as unknown as DhtNode;
    let sentPackets = 0;
    let close!: (error: Error) => void;
    const closed = new Promise<Error>((resolve) => { close = resolve; });
    let changed = 0;
    let rejection: EnrollmentRejection | undefined;
    let storageFailure = false;
    const logs: string[] = [];
    running = await startVpnEngine({ keyPair: receiver, config: { peers: [], vpn: { address: "198.18.8.1", peers: [] } }, dht: server,
      now: Date.now, openTun: async () => ({ name: "fake", packets: { send: async () => { sentPackets++; }, receive: async () => { await closed; } }, closed, close: async () => close(new Error("closed")) }),
      log: (line) => logs.push(line),
      enrollment: { enroll: (key, secret) => storageFailure ? Promise.reject(new Error(`storage error ${secret}`)) : rejection ? Promise.reject(new EnrollmentRejected(rejection)) : store.enroll(key, secret), changed: () => { changed++; } },
    });
    const invite = await store.createInvitation();
    for (const reason of ["capacity", "pool", "route", "excluded"] as const) {
      rejection = reason;
      await assert.rejects(pairWithReceiver({ invitation: invite, keyPair: dialer, dht: client }), new RegExp(`pairing ${reason}`));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    rejection = undefined;
    storageFailure = true;
    await assert.rejects(pairWithReceiver({ invitation: invite, keyPair: dialer, dht: client }), /pairing unknown/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    storageFailure = false;
    assert(logs.some((line) => line.includes("device capacity exhausted")));
    assert(logs.some((line) => line.includes("address pool exhausted")));
    assert(logs.some((line) => line.includes("conflicts with an existing route")));
    assert(logs.some((line) => line.includes("device already has the excluded address")));
    assert(!logs.join("\n").includes(invite));
    assert(!logs.join("\n").includes(invite.split(":")[2]!));
    const config = await pairWithReceiver({ invitation: invite, keyPair: dialer, dht: client });
    assert.equal(config.vpn?.address, "198.18.8.2");
    assert.equal(config.vpn?.peers[0]?.address, "198.18.8.1");
    assert.equal(config.peers[0]?.publicKey, receiverKey);
    assert.equal(sentPackets, 0);
    assert.equal(changed, 1);
    await assert.rejects(pairWithReceiver({ invitation: invite, keyPair: dialer, dht: client }), /pairing unusable/);
    assert.equal((await store.list()).length, 1);
    await running.stop();
    const dialerKey = Buffer.from(dialer.publicKey).toString("hex");
    await store.grant(dialerKey, [443]);
    let closeAgain!: (error: Error) => void;
    const closedAgain = new Promise<Error>((resolve) => { closeAgain = resolve; });
    running = await startVpnEngine({ keyPair: receiver, dht: server, now: Date.now,
      config: { peers: [{ label: "device", publicKey: dialerKey, connection: "accept" }], vpn: { address: "198.18.8.1", peers: [{ peer: "device", address: "198.18.8.2", allowTcp: [443] }] } },
      openTun: async () => ({ name: "fake", packets: { send: async () => { sentPackets++; }, receive: async () => { await closedAgain; } }, closed: closedAgain, close: async () => closeAgain(new Error("closed")) }),
      enrollment: { enroll: (key, secret) => store.enroll(key, secret), changed: () => { changed++; } },
    });
    const renewed = await store.createInvitation();
    const reconnected = await pairWithReceiver({ invitation: renewed, keyPair: dialer, dht: client });
    assert.equal(reconnected.vpn?.address, "198.18.8.2");
    assert.deepEqual((await store.list())[0]?.allowTcp, [443]);
    assert.equal(sentPackets, 0);
  } finally { await running?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("a lost response after submission is unknown, with no secret in the error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-enroll-loss-"));
  try {
    const directory = path.join(root, "peer");
    await setupPeer({ stateDir: directory });
    const pair = keyPairFromSeed((await loadPeerIdentity(directory)).seed);
    const receiver = randomBytes(32).toString("hex"), secret = randomBytes(32).toString("hex");
    const invitation = formatInvitation({ receiverKey: receiver, secret });
    const dht = { connect: () => {
      const stream = new Linked(Buffer.from(receiver, "hex"));
      const other = new Linked(pair.publicKey);
      stream.other = other; other.other = stream;
      other.on("data", () => other.destroy());
      other.on("error", () => {});
      return stream as DhtStream;
    } } as unknown as DhtNode;
    await assert.rejects(pairWithReceiver({ invitation, keyPair: pair, dht }), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "pairing unknown");
      assert(!error.message.includes(secret));
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
