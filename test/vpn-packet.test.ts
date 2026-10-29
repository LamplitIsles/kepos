import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { PacketPolicy } from "../src/vpn/packet-policy.js";
import { PacketFraming } from "../src/vpn/framing.js";

const local = "10.88.0.1";
const remote = "10.88.0.2";

function sum(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i += 2) n += (bytes[i]! << 8) + (bytes[i + 1] ?? 0);
  while (n >>> 16) n = (n & 65535) + (n >>> 16);
  return (~n) & 65535;
}
function ip(source: string, destination: string, protocol: number, payload: Buffer): Buffer {
  const bytes = Buffer.alloc(20 + payload.length);
  bytes[0] = 0x45;
  bytes.writeUInt16BE(bytes.length, 2);
  bytes[8] = 64;
  bytes[9] = protocol;
  source.split(".").forEach((v, i) => { bytes[12 + i] = Number(v); });
  destination.split(".").forEach((v, i) => { bytes[16 + i] = Number(v); });
  bytes.writeUInt16BE(sum(bytes.subarray(0, 20)), 10);
  payload.copy(bytes, 20);
  return bytes;
}
function tcp(source: string, dest: string, sport: number, dport: number, flags: number, seq = 100, ack = 0, data = Buffer.alloc(0)): Buffer {
  const body = Buffer.alloc(20 + data.length);
  body.writeUInt16BE(sport, 0); body.writeUInt16BE(dport, 2);
  body.writeUInt32BE(seq, 4); body.writeUInt32BE(ack, 8);
  body[12] = 0x50; body[13] = flags;
  data.copy(body, 20);
  const packet = ip(source, dest, 6, body);
  const pseudo = Buffer.alloc(12);
  packet.copy(pseudo, 0, 12, 20); pseudo[9] = 6; pseudo.writeUInt16BE(body.length, 10);
  packet.writeUInt16BE(sum(Buffer.concat([pseudo, body])), 36);
  return packet;
}
function control(quoted: Buffer, source = remote, destination = local): Buffer {
  const payload = Buffer.alloc(8 + 28);
  payload[0] = 3; payload[1] = 4;
  quoted.copy(payload, 8, 0, 28);
  payload.writeUInt16BE(sum(payload), 2);
  return ip(source, destination, 1, payload);
}

test("inbound TCP requires a grant and the correct authenticated source", () => {
  const policy = new PacketPolicy(local, remote, [443]);
  assert.equal(policy.admit(tcp(remote, local, 53000, 22, 2), "in"), false);
  assert.equal(policy.admit(tcp("10.88.0.3", local, 53000, 443, 2), "in"), false);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 2), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 18, 50, 101), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 101, 51), "in"), true);
  const revoked = new PacketPolicy(local, remote, []);
  assert.equal(revoked.admit(tcp(remote, local, 53000, 443, 16, 101, 51), "in"), false);
  assert.equal(revoked.admit(tcp(remote, local, 53001, 443, 2), "in"), false);
});

test("outgoing flows admit replies only after a valid SYN-ACK and clear on reconnect", () => {
  const policy = new PacketPolicy(local, remote, []);
  const syn = tcp(local, remote, 53000, 443, 2);
  assert.equal(policy.admit(syn, "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 16), "in"), false);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 18, 5, 102), "in"), false);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 18, 5, 101), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 53000, 443, 16, 101, 6), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 16, 6, 101), "in"), true);
  assert.equal(policy.admit(control(syn), "in"), true);
  policy.clear();
  assert.equal(policy.admit(control(syn), "in"), false);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 16), "in"), false);
});

test("established and half-closed flows survive idle while unsolicited traffic remains denied", () => {
  let now = 0;
  const policy = new PacketPolicy(local, remote, [443], () => now);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 2), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 18, 50, 101), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 101, 51), "in"), true);
  now = 600_000;
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 101, 51), "in"), true);
  assert.equal(policy.admit(tcp(remote, local, 53001, 443, 16, 1, 1), "in"), false);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 17, 101, 51), "in"), true);
  now += 600_000;
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 16, 51, 102, Buffer.from("reply")), "out"), true);
});

test("a reset after SYN-ACK is delivered and releases the unfinished flow", () => {
  const policy = new PacketPolicy(local, remote, []);
  assert.equal(policy.admit(tcp(local, remote, 53000, 443, 2), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 18, 50, 101), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 53000, 443, 4, 101), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 16, 51, 101), "in"), false);
});

test("fully closed flows retain retransmission grace and release capacity", () => {
  let now = 0;
  const policy = new PacketPolicy(local, remote, [443], () => now);
  for (let port = 1; port <= 4096; port++) {
    assert.equal(policy.admit(tcp(remote, local, port, 443, 2), "in"), true);
    assert.equal(policy.admit(tcp(local, remote, 443, port, 18, 50, 101), "out"), true);
    assert.equal(policy.admit(tcp(remote, local, port, 443, 16, 101, 51), "in"), true);
    assert.equal(policy.admit(tcp(remote, local, port, 443, 17, 101, 51), "in"), true);
    assert.equal(policy.admit(tcp(local, remote, 443, port, 16, 51, 102), "out"), true);
    assert.equal(policy.admit(tcp(local, remote, 443, port, 17, 51, 102), "out"), true);
    assert.equal(policy.admit(tcp(remote, local, port, 443, 16, 102, 52), "in"), true);
  }
  assert.equal(policy.admit(tcp(local, remote, 443, 4096, 17, 51, 102), "out"), true, "retransmitted FIN during grace");
  assert.equal(policy.admit(tcp(remote, local, 4096, 443, 16, 102, 52), "in"), true, "ACK for retransmitted FIN");
  assert.equal(policy.admit(tcp(remote, local, 4097, 443, 2), "in"), true, "closed entry is reclaimed at capacity");
  now = 61_000;
  assert.equal(policy.admit(tcp(remote, local, 4096, 443, 16, 102, 52), "in"), false, "closed grace expires");
});

test("capacity never evicts idle established flows to admit unsolicited traffic", () => {
  let now = 0;
  const policy = new PacketPolicy(local, remote, [443], () => now);
  for (let port = 1; port <= 4096; port++) {
    assert.equal(policy.admit(tcp(remote, local, port, 443, 2), "in"), true);
    assert.equal(policy.admit(tcp(local, remote, 443, port, 18, 50, 101), "out"), true);
    assert.equal(policy.admit(tcp(remote, local, port, 443, 16, 101, 51), "in"), true);
  }
  now = 600_000;
  assert.equal(policy.admit(tcp(remote, local, 4097, 443, 2), "in"), false);
  assert.equal(policy.admit(tcp(remote, local, 4097, 443, 16, 101, 51), "in"), false);
  assert.equal(policy.admit(tcp(remote, local, 1, 443, 16, 101, 51), "in"), true);
  assert.equal(policy.admit(tcp(remote, local, 1, 443, 4, 101, 51), "in"), true);
  assert.equal(policy.admit(tcp(remote, local, 4097, 443, 2), "in"), true);
});

test("an unacknowledged FIN is not treated as fully closed", () => {
  let now = 0;
  const policy = new PacketPolicy(local, remote, [443], () => now);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 2), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 18, 50, 101), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 101, 51), "in"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 17, 101, 51), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 17, 51, 102), "out"), true);
  now = 61_000;
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 17, 51, 102), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 102, 52), "in"), true);
});

test("FIN payload, reordered ACKs and wrapped sequence numbers close correctly", () => {
  let now = 0;
  const policy = new PacketPolicy(local, remote, [443], () => now);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 2, 0xffffffff), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 18, 0xfffffffe, 0), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 0, 0xffffffff), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 16, 0xffffffff, 3), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 17, 0, 0xffffffff, Buffer.from("ab")), "in"), true);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 3, 0), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 17, 0xffffffff, 3), "out"), true);
  now = 61_000;
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 16, 3, 0), "in"), false);
});

test("a new inbound SYN on a closed outbound tuple needs an inbound grant", () => {
  const policy = new PacketPolicy(local, remote, []);
  assert.equal(policy.admit(tcp(local, remote, 53000, 443, 2), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 18, 50, 101), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 53000, 443, 16, 101, 51), "out"), true);
  assert.equal(policy.admit(tcp(local, remote, 53000, 443, 17, 101, 51), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 17, 51, 102), "in"), true);
  assert.equal(policy.admit(tcp(local, remote, 53000, 443, 16, 102, 52), "out"), true);
  assert.equal(policy.admit(tcp(remote, local, 443, 53000, 2, 90), "in"), false);
});

test("rejects malformed, fragmented and unsupported packets", () => {
  const policy = new PacketPolicy(local, remote, "all");
  const syn = tcp(remote, local, 5000, 443, 2);
  const fragment = Buffer.from(syn); fragment.writeUInt16BE(0x2000, 6); fragment.writeUInt16BE(0, 10); fragment.writeUInt16BE(sum(fragment.subarray(0, 20)), 10);
  const corrupt = Buffer.from(syn); corrupt[39] = 1;
  assert.equal(policy.admit(fragment, "in"), false);
  assert.equal(policy.admit(corrupt, "in"), false);
  assert.equal(policy.admit(ip(remote, local, 17, Buffer.alloc(8)), "in"), false);
  assert.equal(policy.admit(Buffer.alloc(1401), "in"), false);
});

test("SYN data is rejected without creating a tracked flow", () => {
  const policy = new PacketPolicy(local, remote, [443]);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 2, 100, 0, Buffer.from("data")), "in"), false);
  assert.equal(policy.admit(tcp(local, remote, 443, 53000, 18, 50, 101), "out"), false);
  assert.equal(policy.admit(tcp(remote, local, 53000, 443, 2), "in"), true);
});

test("packet framing handles fragmented chunks and rejects invalid or truncated lengths", async () => {
  const stream = new PassThrough();
  const framing = new PacketFraming(stream);
  const received: Buffer[] = [];
  const reader = framing.receive(async (p) => { received.push(p); });
  const packet = Buffer.alloc(20, 7);
  stream.write(Buffer.from([0]));
  stream.write(Buffer.concat([Buffer.from([20]), packet.subarray(0, 3)]));
  stream.end(packet.subarray(3));
  await reader;
  assert.deepEqual(received, [packet]);
  for (const value of [Buffer.from([0, 19]), Buffer.from([0, 20, 1])]) {
    const bad = new PassThrough();
    const reading = new PacketFraming(bad).receive(async () => {});
    bad.end(value);
    await assert.rejects(reading, /invalid|truncated/);
  }
});

test("flow table expires idle connections and remains bounded", () => {
  let time = 0;
  const policy = new PacketPolicy(local, remote, "all", () => time);
  for (let port = 1; port <= 4096; port++) assert.equal(policy.admit(tcp(remote, local, port, 443, 2), "in"), true);
  assert.equal(policy.admit(tcp(remote, local, 4097, 443, 2), "in"), false);
  time = 300_001;
  assert.equal(policy.admit(tcp(remote, local, 4097, 443, 2), "in"), true);
  assert.equal(policy.admit(tcp(remote, local, 1, 443, 16), "in"), false);
});

test("a blocked writer fails when its stream closes", async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  const sending = new PacketFraming(stream).send(Buffer.alloc(20));
  stream.destroy();
  await assert.rejects(sending, /closed/);
});
