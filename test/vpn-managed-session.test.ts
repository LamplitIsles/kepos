import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { keyPairFromSeed, type DhtKeyPair, type DhtNode, type DhtStream } from "../src/mux/hyperdht.js";
import { loadPeerIdentity, setupPeer } from "../src/state/peer.js";
import type { PacketDevice } from "../src/vpn/engine.js";
import { PacketFraming } from "../src/vpn/framing.js";
import { pairWithReceiver } from "../src/vpn/pair.js";
import { receiverRequest, startReceiver } from "../src/vpn/receiver.js";
import { startVpn } from "../src/vpn/runtime.js";

class Linked extends Duplex {
  other?: Linked;
  connected = true;
  readonly remotePublicKey: Buffer;
  constructor(remote: Uint8Array) { super(); this.remotePublicKey = Buffer.from(remote); }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.other || this.other.destroyed) { callback(new Error("closed")); return; }
    this.other.push(Buffer.from(chunk)); callback();
  }
  override _final(callback: (error?: Error | null) => void): void { this.other?.push(null); callback(); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const other = this.other; this.other = undefined;
    if (other && !other.destroyed) other.destroy();
    callback(error);
  }
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 2) sum += (bytes[index]! << 8) + (bytes[index + 1] ?? 0);
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

function syn(source: string, destination: string, port: number, sourcePort: number): Buffer {
  const packet = Buffer.alloc(40);
  packet[0] = 0x45; packet.writeUInt16BE(40, 2); packet[8] = 64; packet[9] = 6;
  source.split(".").forEach((value, index) => { packet[12 + index] = Number(value); });
  destination.split(".").forEach((value, index) => { packet[16 + index] = Number(value); });
  packet.writeUInt16BE(checksum(packet.subarray(0, 20)), 10);
  packet.writeUInt16BE(sourcePort, 20); packet.writeUInt16BE(port, 22);
  packet.writeUInt32BE(100, 24); packet[32] = 0x50; packet[33] = 2;
  const pseudo = Buffer.alloc(12); packet.copy(pseudo, 0, 12, 20); pseudo[9] = 6; pseudo.writeUInt16BE(20, 10);
  packet.writeUInt16BE(checksum(Buffer.concat([pseudo, packet.subarray(20)])), 36);
  return packet;
}

function fakeDevice() {
  const received: Buffer[] = [];
  let deliver: ((packet: Buffer) => Promise<void>) | undefined;
  let close!: (error: Error) => void;
  const closed = new Promise<Error>((resolve) => { close = resolve; });
  const device: PacketDevice = {
    name: "fake",
    packets: {
      send: async (packet) => { received.push(Buffer.from(packet)); },
      receive: async (callback) => { deliver = callback; await closed; },
    },
    closed,
    close: async () => { deliver = undefined; close(new Error("closed")); },
  };
  return { device, received, inject: async (packet: Buffer) => { assert(deliver); await deliver(packet); } };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test session");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("managed receiver enforces packet grants across enrollment, restriction and revocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-managed-session-"));
  let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
  let dialer: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const receiverDir = path.join(root, "receiver"), dialerDir = path.join(root, "dialer"), strangerDir = path.join(root, "stranger");
    const receiverKey = (await setupPeer({ stateDir: receiverDir })).publicKey;
    const dialerKey = (await setupPeer({ stateDir: dialerDir })).publicKey;
    await setupPeer({ stateDir: strangerDir });
    const dialerPair = keyPairFromSeed((await loadPeerIdentity(dialerDir)).seed);
    const strangerPair = keyPairFromSeed((await loadPeerIdentity(strangerDir)).seed);
    let firewall!: (key: Uint8Array) => boolean;
    let accept!: (stream: DhtStream) => void;
    let receiverGeneration = 0;
    let dialStream: Linked | undefined;
    const receiverDht = { createServer: (options: { firewall: (key: Uint8Array) => boolean }, callback: (stream: DhtStream) => void) => {
      firewall = options.firewall; accept = callback;
      return { listen: async () => {}, close: async () => {} };
    } } as unknown as DhtNode;
    const dialerDht = { createServer: () => ({ listen: async () => {}, close: async () => {} }),
      connect: (_remote: Uint8Array, options: { keyPair: DhtKeyPair }) => {
        const client = new Linked(Buffer.from(receiverKey, "hex")), server = new Linked(options.keyPair.publicKey);
        client.other = server; server.other = client;
        if (Buffer.from(options.keyPair.publicKey).toString("hex") === dialerKey) dialStream = client;
        queueMicrotask(() => { if (firewall(options.keyPair.publicKey)) server.destroy(); else accept(server as DhtStream); });
        return client as DhtStream;
      },
    } as unknown as DhtNode;
    let receiverDevice = fakeDevice();
    const start: typeof startVpn = async (options) => {
      receiverDevice = fakeDevice();
      const instance = await startVpn({ ...options, dht: receiverDht, openTun: async () => receiverDevice.device });
      receiverGeneration++;
      return instance;
    };
    receiver = await startReceiver({ stateDir: receiverDir, helper: "unused", pool: "198.18.20.0/24",
      config: { peers: [], vpn: { address: "192.168.1.88", peers: [] } }, start, checkPool: async () => {} });
    const response = await receiverRequest(receiverDir, { action: "invite" }) as { invitation: string };
    const config = await pairWithReceiver({ invitation: response.invitation, keyPair: dialerPair, dht: dialerDht });
    await waitFor(() => receiverGeneration >= 2);
    const clientDevice = fakeDevice();
    let connected = false;
    dialer = await startVpn({ stateDir: dialerDir, helper: "unused", config, dht: dialerDht, openTun: async () => clientDevice.device,
      onPeerStatus: (status) => { connected = status.connected; } });
    await waitFor(() => connected);
    const source = config.vpn!.address, destination = config.vpn!.peers[0]!.address;
    assert.equal(destination, "192.168.1.88");
    await clientDevice.inject(syn(source, destination, 22, 50000));
    await waitFor(() => receiverDevice.received.length === 1);
    await clientDevice.inject(syn(source, destination, 443, 50001));
    await waitFor(() => receiverDevice.received.length === 2);

    const spoof = syn("198.18.20.99", destination, 443, 50002);
    await new PacketFraming(dialStream!).send(spoof);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(receiverDevice.received.length, 2, "an authenticated peer cannot spoof a source address");
    await clientDevice.inject(syn(source, destination, 443, 50003));
    await waitFor(() => receiverDevice.received.length === 3);

    const unknown = dialerDht.connect(Buffer.from(receiverKey, "hex"), { keyPair: strangerPair, localConnection: true, reusableSocket: true }) as Linked;
    unknown.on("error", () => {});
    const unknownClosed = once(unknown, "close");
    const unknownFrames = new PacketFraming(unknown);
    await unknownFrames.send(Buffer.from("Kepos VPN IPv4 v1\0\0\0", "ascii"));
    await unknownFrames.send(syn("198.18.20.100", destination, 443, 50004)).catch(() => {});
    await unknownClosed;
    assert.equal(receiverDevice.received.length, 3, "an unknown identity cannot reach packet forwarding");

    await receiverRequest(receiverDir, { action: "grant", key: dialerKey, ports: [443] });
    await waitFor(() => connected);
    await clientDevice.inject(syn(source, destination, 22, 50005));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(receiverDevice.received.length, 0, "restriction blocks a previously allowed port");
    await clientDevice.inject(syn(source, destination, 443, 50006));
    await waitFor(() => receiverDevice.received.length === 1);

    const revokedStream = dialStream!;
    await receiverRequest(receiverDir, { action: "revoke", key: dialerKey });
    await waitFor(() => revokedStream.destroyed && !connected);
    await clientDevice.inject(syn(source, destination, 443, 50007));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(receiverDevice.received.length, 0, "revocation blocks the former device");
  } finally {
    await dialer?.stop();
    await receiver?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
