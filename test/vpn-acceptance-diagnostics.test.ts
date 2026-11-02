import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { test } from "node:test";
import type { DhtNode, DhtStream } from "../src/mux/hyperdht.js";

// The normal build replaces this flag with false; this process exercises the
// diagnostic compilation mode without a network or a real identity.
Object.defineProperty(globalThis, "KEPOS_ACCEPTANCE_DIAGNOSTICS", { value: true });
const { runWorkletBridge } = await import("../src/vpn/worklet-bridge.js");
const { startVpnEngine } = await import("../src/vpn/engine.js");
const { PacketFraming } = await import("../src/vpn/framing.js");
const { PacketPolicy } = await import("../src/vpn/packet-policy.js");
const { IPC_CONTROL, IPC_PACKET, WorkletFraming } = await import("../src/vpn/worklet-framing.js");
const { acceptanceEvent, setAcceptanceSink } = await import("../src/vpn/acceptance-diagnostics.js");

class Linked extends Duplex {
  other?: Linked;
  remotePublicKey = Buffer.alloc(32);
  override _read(): void {}
  override _write(data: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (!this.other || this.other.destroyed) return done(new Error("closed"));
    this.other.push(Buffer.from(data));
    done();
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    const other = this.other; this.other = undefined;
    if (other && !other.destroyed) other.destroy();
    done(error);
  }
}
function pair(): [Linked, Linked] {
  const a = new Linked(), b = new Linked(); a.other = b; b.other = a;
  a.on("error", () => {}); b.on("error", () => {});
  return [a, b];
}
function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i]! << 8) + (bytes[i + 1] ?? 0);
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}
function syn(source: number): Buffer {
  const packet = Buffer.alloc(40);
  packet[0] = 0x45; packet.writeUInt16BE(40, 2); packet[8] = 64; packet[9] = 6;
  packet.set([198, 18, 0, source, 198, 18, 0, 1], 12);
  packet.writeUInt16BE(checksum(packet.subarray(0, 20)), 10);
  packet.writeUInt16BE(53000, 20); packet.writeUInt16BE(443, 22);
  packet.writeUInt32BE(100, 24); packet[32] = 0x50; packet[33] = 2;
  const pseudo = Buffer.alloc(12); packet.copy(pseudo, 0, 12, 20); pseudo[9] = 6; pseudo.writeUInt16BE(20, 10);
  packet.writeUInt16BE(checksum(Buffer.concat([pseudo, packet.subarray(20)])), 36);
  return packet;
}

test("diagnostic worklet reports real engine decisions without forwarding a spoof", async () => {
  const [client, provider] = pair();
  const frames = new WorkletFraming(client);
  const messages: Array<{ kind: number; payload: Buffer }> = [];
  let wake: (() => void) | undefined;
  const received = frames.receive(async (kind, payload) => {
    messages.push({ kind, payload: Buffer.from(payload) });
    wake?.(); wake = undefined;
  });
  const next = async (): Promise<{ kind: number; payload: Buffer }> => {
    if (!messages.length) await Promise.race([
      new Promise<void>((resolve) => { wake = resolve; }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("diagnostic test timeout")), 2000).unref()),
    ]);
    return messages.shift()!;
  };
  const nextControl = async (type: string): Promise<Record<string, unknown>> => {
    const message = await next();
    assert.equal(message.kind, IPC_CONTROL);
    const value = JSON.parse(message.payload.toString()) as Record<string, unknown>;
    assert.equal(value.type, type);
    return value;
  };
  const key = "12".repeat(32);
  const config = `[[peers]]\nlabel = "remote"\npublic_key = "${key}"\nconnection = "accept"\n[vpn]\naddress = "198.18.0.1"\npeers = [{ peer = "remote", address = "198.18.0.2", allow_tcp = [443] }]\n`;
  let firewall!: (key: Uint8Array) => boolean;
  let accept!: (stream: DhtStream) => void;
  const dht = { createServer: (options: { firewall: (key: Uint8Array) => boolean }, handler: (stream: DhtStream) => void) => {
    firewall = options.firewall; accept = handler;
    return { listen: async () => {}, close: async () => {} };
  }, destroy: async () => {} } as unknown as DhtNode;
  const running = runWorkletBridge(provider, (options) => startVpnEngine({ ...options, dht }));
  const [remote, engineStream] = pair();
  engineStream.remotePublicKey = Buffer.from(key, "hex");
  try {
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", seed: "07".repeat(32), config })));
    await nextControl("settings");
    await frames.send(IPC_CONTROL, Buffer.from('{"type":"ready"}'));
    await nextControl("running");

    assert.equal(firewall(Buffer.alloc(32)), true);
    assert.equal((await nextControl("acceptance-diagnostic")).event, "admission_unknown");
    assert.equal(firewall(Buffer.from(key, "hex")), false);
    assert.equal((await nextControl("acceptance-diagnostic")).event, "admission_accepted");
    accept(engineStream as unknown as DhtStream);
    const peerFrames = new PacketFraming(remote);
    const greeting = Buffer.from("Kepos VPN IPv4 v1\0\0\0", "ascii");
    let remoteGreeting!: () => void;
    const greetingReceived = new Promise<void>((resolve) => { remoteGreeting = resolve; });
    const peerRead = peerFrames.receive(async (packet) => { if (packet.equals(greeting)) remoteGreeting(); });
    await peerFrames.send(greeting);
    await greetingReceived;
    await nextControl("peer");

    await peerFrames.send(syn(3));
    assert.equal((await nextControl("acceptance-diagnostic")).event, "source_mismatch");
    assert.equal(messages.some((entry) => entry.kind === IPC_PACKET), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await peerFrames.send(syn(2));
    const nextMessages = [await next(), await next()];
    const forwarded = nextMessages.find((entry) => entry.kind === IPC_PACKET);
    assert.deepEqual(forwarded?.payload, syn(2));
    const diag = nextMessages.find((entry) => entry.kind === IPC_CONTROL);
    assert.equal(JSON.parse(diag!.payload.toString()).event, "policy_admitted");
    remote.destroy();
    await peerRead.catch(() => undefined);
  } finally {
    remote.destroy(); client.destroy(); await running; await received.catch(() => undefined);
  }
});

test("acceptance diagnostics are bounded and ignore a throwing sink", () => {
  const seen: string[] = [];
  setAcceptanceSink((event) => { seen.push(event); });
  acceptanceEvent("policy_admitted");
  assert.deepEqual(seen, []);
  acceptanceEvent("source_mismatch");
  acceptanceEvent("policy_admitted");
  assert.deepEqual(seen, ["source_mismatch", "policy_admitted"]);
  seen.length = 0;
  for (let i = 0; i < 100; i++) acceptanceEvent("admission_unknown");
  assert.deepEqual(seen, ["admission_unknown", "admission_unknown", "admission_unknown"]);
  setAcceptanceSink(() => { throw new Error("SECRET_TEST_ONLY"); });
  assert.doesNotThrow(() => acceptanceEvent("source_mismatch"));
  const policy = new PacketPolicy("198.18.0.1", "198.18.0.2", [443]);
  assert.equal(policy.admit(syn(3), "in"), false);
  assert.equal(policy.admit(syn(2), "in"), true);
  setAcceptanceSink();
});

test("diagnostics do not consume normal IPC queue capacity", async () => {
  class Blocked extends Duplex {
    constructor() { super({ writableHighWaterMark: 1 }); }
    override _read(): void {}
    override _write(_data: Buffer, _encoding: BufferEncoding, _done: (error?: Error | null) => void): void {}
  }
  const stream = new Blocked();
  stream.on("error", () => {});
  const frames = new WorkletFraming(stream);
  frames.sendDiagnostic(Buffer.from("diagnostic"));
  const normal = Array.from({ length: 32 }, () => frames.send(IPC_CONTROL, Buffer.from("normal")).catch(() => undefined));
  await assert.rejects(frames.send(IPC_CONTROL, Buffer.from("overload")), /congested/);
  stream.destroy();
  await Promise.all(normal);
});
