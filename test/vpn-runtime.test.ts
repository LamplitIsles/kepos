import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import { setupPeer } from "../src/state/peer.js";
import type { DhtNode, DhtStream } from "../src/mux/hyperdht.js";
import { PacketFraming } from "../src/vpn/framing.js";
import { startVpn } from "../src/vpn/runtime.js";

class Linked extends Duplex {
  other?: Linked;
  connected = true;
  remotePublicKey: Buffer;
  constructor(remote: string) { super(); this.remotePublicKey = Buffer.from(remote, "hex"); }
  override _read(): void {}
  override _write(data: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (!this.other || this.other.destroyed) { cb(new Error("closed")); return; }
    this.other.push(Buffer.from(data)); cb();
  }
  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    const other = this.other; this.other = undefined;
    if (other && !other.destroyed) other.destroy();
    cb(error);
  }
}
function sum(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i += 2) n += (bytes[i]! << 8) + (bytes[i + 1] ?? 0);
  while (n >>> 16) n = (n & 65535) + (n >>> 16);
  return (~n) & 65535;
}
function syn(port: number, sourceLast = 1): Buffer {
  const p = Buffer.alloc(40); p[0] = 0x45; p.writeUInt16BE(40, 2); p[8] = 64; p[9] = 6;
  p.set([198, 18, 0, sourceLast, 198, 18, 0, 2], 12); p.writeUInt16BE(sum(p.subarray(0, 20)), 10);
  p.writeUInt16BE(51000, 20); p.writeUInt16BE(port, 22); p.writeUInt32BE(100, 24); p[32] = 0x50; p[33] = 2;
  const pseudo = Buffer.alloc(12); p.copy(pseudo, 0, 12, 20); pseudo[9] = 6; pseudo.writeUInt16BE(20, 10);
  p.writeUInt16BE(sum(Buffer.concat([pseudo, p.subarray(20)])), 36); return p;
}
function synAck(): Buffer {
  const p = syn(443);
  p.set([198, 18, 0, 2, 198, 18, 0, 1], 12);
  p.writeUInt16BE(443, 20); p.writeUInt16BE(51000, 22);
  p.writeUInt32BE(50, 24); p.writeUInt32BE(101, 28); p[33] = 18;
  p.writeUInt16BE(0, 10); p.writeUInt16BE(sum(p.subarray(0, 20)), 10);
  p.writeUInt16BE(0, 36);
  const pseudo = Buffer.alloc(12); p.copy(pseudo, 0, 12, 20); pseudo[9] = 6; pseudo.writeUInt16BE(20, 10);
  p.writeUInt16BE(sum(Buffer.concat([pseudo, p.subarray(20)])), 36);
  return p;
}
function fakeTun() {
  const fromHost = new PassThrough(); const toHost = new PassThrough();
  let close!: (error: Error) => void;
  const closed = new Promise<Error>((resolve) => { close = resolve; });
  return { fromHost, toHost, device: { name: "fake0", packets: new PacketFraming(fromHost, toHost), closed,
    close: async () => { fromHost.destroy(); toHost.destroy(); close(new Error("closed")); } } };
}

test("two fake peers dispatch authenticated VPN frames and enforce port grants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-test-"));
  let a: Awaited<ReturnType<typeof startVpn>> | undefined, b: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const aState = path.join(root, "a"), bState = path.join(root, "b");
    const aKey = (await setupPeer({ stateDir: aState })).publicKey;
    const bKey = (await setupPeer({ stateDir: bState })).publicKey;
    const aTun = fakeTun(), bTun = fakeTun();
    let handler: ((stream: DhtStream) => void) | undefined;
    let firewall: ((key: Uint8Array) => boolean) | undefined;
    const common = { stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } }, destroy: async () => {} };
    const bDht = { ...common, createServer: (opts: { firewall: (key: Uint8Array) => boolean }, onConnection: (stream: DhtStream) => void) => {
      firewall = opts.firewall; handler = onConnection; return { listen: async () => {}, close: async () => {} };
    } } as unknown as DhtNode;
    const aDht = { ...common, createServer: () => ({ listen: async () => {}, close: async () => {} }), connect: () => {
      const x = new Linked(bKey), y = new Linked(aKey); x.other = y; y.other = x;
      queueMicrotask(() => { if (!firewall!(Buffer.from(aKey, "hex"))) handler!(y as unknown as DhtStream); else y.destroy(); });
      return x as unknown as DhtStream;
    } } as unknown as DhtNode;
    const base = {};
    b = await startVpn({ stateDir: bState, helper: "fake", dht: bDht, openTun: async () => bTun.device,
      config: { ...base, peers: [{ label: "a", publicKey: aKey, connection: "accept" }], vpn: { address: "198.18.0.2", peers: [{ peer: "a", address: "198.18.0.1", allowTcp: [443] }] } } });
    assert.equal(firewall!(Buffer.alloc(32)), true);
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    a = await startVpn({ stateDir: aState, helper: "fake", dht: aDht, openTun: async () => aTun.device,
      log: (line) => { if (line.startsWith("VPN peer connected")) connected(); },
      config: { ...base, peers: [{ label: "b", publicKey: bKey, connection: "dial" }], vpn: { address: "198.18.0.1", peers: [{ peer: "b", address: "198.18.0.2", allowTcp: [] }] } } });
    await ready;
    const writer = new PacketFraming(aTun.fromHost);
    const delivered = once(bTun.toHost, "data");
    await writer.send(syn(443));
    const [frame] = await delivered as [Buffer];
    assert.deepEqual(frame.subarray(2), syn(443));
    assert.equal(frame.readUInt16BE(0), 40);
    bTun.toHost.pause();
    await writer.send(syn(22));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bTun.toHost.readableLength, 0);
  } finally {
    await a?.stop(); await b?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a packet dropped by a busy TUN does not create flow state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-busy-"));
  let running: Awaited<ReturnType<typeof startVpn>> | undefined;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const state = path.join(root, "peer");
    await setupPeer({ stateDir: state });
    const tun = fakeTun(), firstKey = "ab".repeat(32), secondKey = "cd".repeat(32);
    let handler!: (stream: DhtStream) => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const sent: Buffer[] = [];
    tun.device.packets.send = async (packet) => {
      sent.push(Buffer.from(packet));
      if (sent.length === 1) { entered(); await blocked; }
    };
    const dht = { createServer: (_opts: unknown, onConnection: (stream: DhtStream) => void) => {
      handler = onConnection; return { listen: async () => {}, close: async () => {} };
    }, destroy: async () => {} } as unknown as DhtNode;
    let readyCount = 0, ready!: () => void;
    const bothReady = new Promise<void>((resolve) => { ready = resolve; });
    running = await startVpn({ stateDir: state, helper: "fake", dht, openTun: async () => tun.device,
      config: { peers: [{ label: "first", publicKey: firstKey, connection: "accept" }, { label: "second", publicKey: secondKey, connection: "accept" }],
        vpn: { address: "198.18.0.2", peers: [{ peer: "first", address: "198.18.0.3", allowTcp: [443] }, { peer: "second", address: "198.18.0.1", allowTcp: [443] }] } },
      log: (line) => { if (line.startsWith("VPN peer connected") && ++readyCount === 2) ready(); },
    });
    const clients = [firstKey, secondKey].map((key) => {
      const client = new Linked("00".repeat(32)), server = new Linked(key);
      client.other = server; server.other = client; client.on("error", () => {});
      handler(server as unknown as DhtStream);
      client.resume();
      return client;
    });
    await Promise.all(clients.map((client) => new PacketFraming(client).send(Buffer.from("Kepos VPN IPv4 v1\0\0\0"))));
    await bothReady;
    await new PacketFraming(clients[0]!).send(syn(443, 3));
    await writing;
    await new PacketFraming(clients[1]!).send(syn(443));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replies: Buffer[] = [];
    clients[1]!.on("data", (chunk: Buffer) => replies.push(chunk));
    await new PacketFraming(tun.fromHost).send(synAck());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replies.length, 0, "a dropped SYN must not authorize a reply");
    release();
    await new PacketFraming(clients[1]!).send(syn(443));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2, "a retransmitted SYN is delivered after the TUN is available");
    await new PacketFraming(tun.fromHost).send(synAck());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(replies.length, 1, "the delivered SYN authorizes its reply");
  } finally { release(); await running?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("wrong VPN protocol is closed and does not admit packets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-protocol-"));
  let running: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const state = path.join(root, "peer");
    await setupPeer({ stateDir: state });
    const key = "cd".repeat(32), tun = fakeTun();
    const logs: string[] = [];
    let now = 10_000;
    let handler!: (stream: DhtStream) => void;
    let firewall!: (key: Uint8Array) => boolean;
    const dht = { stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } },
      createServer: (opts: { firewall: (key: Uint8Array) => boolean }, onConnection: (stream: DhtStream) => void) => {
        firewall = opts.firewall; handler = onConnection; return { listen: async () => {}, close: async () => {} };
      }, destroy: async () => {} } as unknown as DhtNode;
    running = await startVpn({ stateDir: state, helper: "fake", dht, openTun: async () => tun.device, log: (line) => logs.push(line), now: () => now,
      config: { peers: [{ label: "remote", publicKey: key, connection: "accept" }],
        vpn: { address: "198.18.0.2", peers: [{ peer: "remote", address: "198.18.0.1", allowTcp: "all" }] } } });
    assert.equal(firewall(Buffer.alloc(32)), true);
    assert.equal(firewall(Buffer.from(key, "hex")), false);
    assert.equal(firewall(Buffer.from(key, "hex")), true);
    assert(logs.some((line) => line.includes("peer is unknown or not configured to accept")));
    assert(logs.some((line) => line.includes("authenticated handshake admitted")));
    assert(logs.some((line) => line.includes("handshake retry rate limit")));
    const client = new Linked("00".repeat(32)), server = new Linked(key); client.other = server; server.other = client;
    client.on("error", () => {});
    handler(server as unknown as DhtStream);
    now += 1001;
    assert.equal(firewall(Buffer.from(key, "hex")), true);
    assert(logs.some((line) => line.includes("session is already active")));
    const closed = once(client, "close");
    await new PacketFraming(client).send(Buffer.alloc(20, 0x42));
    await closed;
    assert.equal(tun.toHost.readableLength, 0);
    now += 1001;
    assert.equal(firewall(Buffer.from(key, "hex")), false);
  } finally { await running?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("exclusive peer lock rejects a second runtime and becomes available after release", async () => {
  const { acquirePeerRuntimeLock } = await import("../src/runtime/runtime-lock.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-lock-"));
  try {
    const state = path.join(root, "peer");
    const first = await acquirePeerRuntimeLock(state);
    try { await assert.rejects(acquirePeerRuntimeLock(state), /already in use/); }
    finally { await first.release(); }
    const next = await acquirePeerRuntimeLock(state);
    await next.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("VPN startup failure releases the identity lock", { skip: process.platform !== "linux" }, async () => {
  const { runCli, createDefaultCliDependencies } = await import("../src/cli/main.js");
  const { acquirePeerRuntimeLock } = await import("../src/runtime/runtime-lock.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-startup-"));
  try {
    const state = path.join(root, "peer");
    await setupPeer({ stateDir: state });
    const deps = createDefaultCliDependencies({ stdout: () => {}, stderr: () => {} });
    deps.loadConfig = async () => ({ peers: [], vpn: { address: "198.18.0.1", peers: [] } });
    await assert.rejects(runCli(["peer", "vpn", "--state", state, "--config", path.join(root, "config.toml"), "--tun-helper", path.join(root, "missing")], deps), /TUN helper/);
    const lock = await acquirePeerRuntimeLock(state);
    await lock.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("VPN CLI stops the old generation before starting a changed policy", async () => {
  const { runCli, createDefaultCliDependencies } = await import("../src/cli/main.js");
  const events: string[] = [];
  let config = { peers: [], vpn: { address: "198.18.0.1", peers: [] } };
  let reload!: () => void;
  let secondReady!: () => void;
  const restarted = new Promise<void>((resolve) => { secondReady = resolve; });
  const deps = createDefaultCliDependencies({ stdout: () => {}, stderr: () => {} });
  deps.loadConfig = async () => config;
  deps.acquirePeerRuntimeLock = async () => ({ release: async () => { events.push("release"); } });
  deps.startVpn = async ({ config: current }) => {
    const address = current.vpn!.address;
    events.push(`start ${address}`);
    if (address === "198.18.0.2") secondReady();
    return { peerKey: "key", interfaceName: "fake0", failed: new Promise<Error>(() => {}), stop: async () => { events.push(`stop ${address}`); } };
  };
  deps.scheduleConfigReload = (callback) => { reload = callback; return () => {}; };
  deps.waitForSignal = async (stop) => {
    config = { ...config, vpn: { ...config.vpn, address: "198.18.0.2" } };
    reload();
    await restarted;
    await stop();
  };
  await runCli(["peer", "vpn", "--state", "/tmp/test-only-peer", "--config", "/tmp/test-only-config", "--tun-helper", "/tmp/test-only-helper"], deps);
  assert.deepEqual(events, ["start 198.18.0.1", "stop 198.18.0.1", "start 198.18.0.2", "stop 198.18.0.2", "stop 198.18.0.2", "release"]);
});

test("VPN CLI stops and unlocks if policy reload is invalid", async () => {
  const { runCli, createDefaultCliDependencies } = await import("../src/cli/main.js");
  const events: string[] = [];
  const signalListeners = process.listenerCount("SIGTERM");
  let reads = 0;
  const deps = createDefaultCliDependencies({ stdout: () => {}, stderr: () => {} });
  deps.loadConfig = async () => {
    if (++reads > 1) throw new Error("invalid changed config");
    return { peers: [], vpn: { address: "198.18.0.1", peers: [] } };
  };
  deps.acquirePeerRuntimeLock = async () => ({ release: async () => { events.push("release"); } });
  deps.startVpn = async () => ({ peerKey: "key", interfaceName: "fake0", failed: new Promise<Error>(() => {}), stop: async () => { events.push("stop"); } });
  deps.scheduleConfigReload = (callback) => { queueMicrotask(callback); return () => {}; };
  await assert.rejects(runCli(["peer", "vpn", "--state", "/tmp/test-only-peer", "--config", "/tmp/test-only-config", "--tun-helper", "/tmp/test-only-helper"], deps), /invalid changed config/);
  assert.deepEqual(events, ["stop", "release"]);
  assert.equal(process.listenerCount("SIGTERM"), signalListeners, "failure removes signal listeners");
});

test("VPN identifies a streamx close during the protocol handshake", async () => {
  const { createRequire } = await import("node:module");
  const streamx = createRequire(import.meta.url)("streamx") as typeof import("streamx");
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-diag-"));
  let running: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const state = path.join(root, "peer"), remoteKey = "cd".repeat(32), tun = fakeTun();
    await setupPeer({ stateDir: state });
    let closedLog!: (line: string) => void;
    const observed = new Promise<string>((resolve) => { closedLog = resolve; });
    const dht = {
      stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } },
      createServer: () => ({ listen: async () => {}, close: async () => {} }),
      connect: () => {
        const stream = new streamx.Duplex({
          read(callback) { callback(null); },
          write(_data, callback) { callback(null); queueMicrotask(() => stream.destroy()); },
        });
        Object.assign(stream, { connected: true, remotePublicKey: Buffer.from(remoteKey, "hex") });
        return stream;
      },
      destroy: async () => {},
    } as unknown as DhtNode;
    running = await startVpn({ stateDir: state, helper: "fake", dht, openTun: async () => tun.device,
      config: { peers: [{ label: "remote", publicKey: remoteKey, connection: "dial" }],
        vpn: { address: "198.18.0.1", peers: [{ peer: "remote", address: "198.18.0.2", allowTcp: [] }] } },
      log: (line) => { if (line.includes("Stream was destroyed")) closedLog(line); },
    });
    const line = await observed;
    assert.match(line, /VPN handshake with remote failed: Stream was destroyed/);
  } finally { await running?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("VPN reports the peer and pre-transport phase on DHT connection failure", async () => {
  const { createRequire } = await import("node:module");
  const streamx = createRequire(import.meta.url)("streamx") as typeof import("streamx");
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-dial-"));
  let running: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const state = path.join(root, "peer"), remoteKey = "ab".repeat(32), tun = fakeTun();
    await setupPeer({ stateDir: state });
    let failed!: (line: string) => void;
    const observed = new Promise<string>((resolve) => { failed = resolve; });
    const dht = {
      stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } },
      createServer: () => ({ listen: async () => {}, close: async () => {} }),
      connect: () => {
        const stream = new streamx.Duplex({ read(callback) { callback(null); }, write(_data, callback) { callback(null); } });
        Object.assign(stream, { connected: false, remotePublicKey: Buffer.from(remoteKey, "hex") });
        queueMicrotask(() => stream.destroy(new Error("PEER_CONNECTION_FAILED: Could not connect to peer")));
        return stream;
      },
      destroy: async () => {},
    } as unknown as DhtNode;
    running = await startVpn({ stateDir: state, helper: "fake", dht, openTun: async () => tun.device,
      config: { peers: [{ label: "remote", publicKey: remoteKey, connection: "dial" }],
        vpn: { address: "198.18.0.1", peers: [{ peer: "remote", address: "198.18.0.2", allowTcp: [] }] } },
      log: (line) => { if (line.includes("PEER_CONNECTION_FAILED")) failed(line); },
    });
    assert.equal(await observed, "VPN dial to remote failed before transport connected: PEER_CONNECTION_FAILED: Could not connect to peer");
  } finally { await running?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("a failed admitted handshake does not block the next timed retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-retry-"));
  let running: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const state = path.join(root, "peer"), key = "cd".repeat(32), tun = fakeTun();
    await setupPeer({ stateDir: state });
    let firewall!: (key: Uint8Array) => boolean;
    const dht = {
      stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } },
      createServer: (opts: { firewall: (key: Uint8Array) => boolean }) => {
        firewall = opts.firewall; return { listen: async () => {}, close: async () => {} };
      },
      destroy: async () => {},
    } as unknown as DhtNode;
    let now = 10_000;
    running = await startVpn({ stateDir: state, helper: "fake", dht, openTun: async () => tun.device, now: () => now,
      config: { peers: [{ label: "remote", publicKey: key, connection: "accept" }],
        vpn: { address: "198.18.0.2", peers: [{ peer: "remote", address: "198.18.0.1", allowTcp: [] }] } } });
    const remote = Buffer.from(key, "hex");
    assert.equal(firewall(remote), false);
    // HyperDHT can abandon this attempt without invoking its connection callback.
    assert.equal(firewall(remote), true);
    now += 1001;
    assert.equal(firewall(remote), false, "a fresh retry must not wait for a stale reservation");
    assert.equal(firewall(remote), true, "simultaneous attempts remain rate-limited");
  } finally { await running?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("VPN handshake and packets work over real Noise SecretStreams with in-memory transport", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const NoiseWrap = require("hyperdht/lib/noise-wrap");
  const SecretStream = require("@hyperswarm/secret-stream");
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-noise-"));
  let a: Awaited<ReturnType<typeof startVpn>> | undefined, b: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const aState = path.join(root, "a"), bState = path.join(root, "b");
    const aKey = (await setupPeer({ stateDir: aState })).publicKey;
    const bKey = (await setupPeer({ stateDir: bState })).publicKey;
    const aTun = fakeTun(), bTun = fakeTun();
    let handler!: (stream: DhtStream) => void;
    let firewall!: (key: Uint8Array) => boolean;
    let bPair: unknown;
    const common = { stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } }, destroy: async () => {} };
    const bDht = { ...common, createServer: (opts: { firewall: (key: Uint8Array) => boolean }, onConnection: (stream: DhtStream) => void) => {
      firewall = opts.firewall; handler = onConnection; return { listen: async (pair: unknown) => { bPair = pair; }, close: async () => {} };
    } } as unknown as DhtNode;
    const aDht = { ...common, createServer: () => ({ listen: async () => {}, close: async () => {} }),
      connect: (_remote: Uint8Array, opts: { keyPair: unknown }) => {
        const initiator = new NoiseWrap(opts.keyPair, Buffer.from(bKey, "hex"));
        const responder = new NoiseWrap(bPair, null);
        const payload = { error: 0, firewall: 0 };
        responder.recv(initiator.send(payload));
        initiator.recv(responder.send(payload));
        const x = new SecretStream(true, null, { autoStart: false });
        const y = new SecretStream(false, null, { autoStart: false });
        x.start(null, { handshake: initiator.final() });
        y.start(null, { handshake: responder.final() });
        x.rawStream.pipe(y.rawStream).pipe(x.rawStream);
        queueMicrotask(() => { if (!firewall(Buffer.from(aKey, "hex"))) handler(y as DhtStream); else y.destroy(); });
        return x as DhtStream;
      } } as unknown as DhtNode;
    const base = {};
    b = await startVpn({ stateDir: bState, helper: "fake", dht: bDht, openTun: async () => bTun.device,
      config: { ...base, peers: [{ label: "a", publicKey: aKey, connection: "accept" }], vpn: { address: "198.18.0.2", peers: [{ peer: "a", address: "198.18.0.1", allowTcp: [443] }] } } });
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => { connected = resolve; });
    a = await startVpn({ stateDir: aState, helper: "fake", dht: aDht, openTun: async () => aTun.device,
      log: (line) => { if (line.startsWith("VPN peer connected")) connected(); },
      config: { ...base, peers: [{ label: "b", publicKey: bKey, connection: "dial" }], vpn: { address: "198.18.0.1", peers: [{ peer: "b", address: "198.18.0.2", allowTcp: [] }] } } });
    await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Noise handshake timed out")), 2000).unref())]);
    const delivered = once(bTun.toHost, "data");
    await new PacketFraming(aTun.fromHost).send(syn(443));
    const [frame] = await delivered as [Buffer];
    assert.deepEqual(frame.subarray(2), syn(443));
  } finally { await a?.stop(); await b?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("VPN handshake timeout reports redacted transport packet counters", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createRequire } = await import("node:module");
  const streamx = createRequire(import.meta.url)("streamx") as typeof import("streamx");
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-timeout-"));
  let running: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const state = path.join(root, "peer"), key = "cd".repeat(32), tun = fakeTun();
    await setupPeer({ stateDir: state });
    let opened!: () => void, timedOut!: (line: string) => void;
    const open = new Promise<void>((resolve) => { opened = resolve; });
    const timeout = new Promise<string>((resolve) => { timedOut = resolve; });
    const dht = {
      stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } },
      createServer: () => ({ listen: async () => {}, close: async () => {} }),
      connect: () => {
        const stream = new streamx.Duplex({ read(callback) { callback(null); }, write(_data, callback) { callback(null); } });
        Object.assign(stream, { connected: true, remotePublicKey: Buffer.from(key, "hex"), rawStream: { packetsTransmitted: 3, packetsReceived: 0, retransmits: 2 }, toJSON: () => ({ connected: true, publicKey: key, remotePublicKey: key, secretKey: "SECRET_VALUE", packet: "PACKET_CONTENT" }) });
        return stream;
      }, destroy: async () => {},
    } as unknown as DhtNode;
    running = await startVpn({ stateDir: state, helper: "fake", dht, openTun: async () => tun.device,
      config: { peers: [{ label: "remote", publicKey: key, connection: "dial" }],
        vpn: { address: "198.18.0.1", peers: [{ peer: "remote", address: "198.18.0.2", allowTcp: [] }] } },
      log: (line) => { if (line.includes("opened locally")) opened(); if (line.includes("VPN handshake timeout")) timedOut(line); },
    });
    await open;
    t.mock.timers.tick(10_000);
    const line = await timeout;
    assert.match(line, /VPN handshake timeout with remote/);
    assert.match(line, /"packetsTransmitted":3/);
    assert.match(line, /"packetsReceived":0/);
    assert.doesNotMatch(line, new RegExp(key.slice(0, 16)));
    assert.doesNotMatch(line, /SECRET_VALUE|PACKET_CONTENT/);
  } finally { await running?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("VPN diagnostic errors do not print arbitrary transport data", async () => {
  const { createRequire } = await import("node:module");
  const streamx = createRequire(import.meta.url)("streamx") as typeof import("streamx");
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-vpn-redact-"));
  let running: Awaited<ReturnType<typeof startVpn>> | undefined;
  try {
    const state = path.join(root, "peer"), key = "ab".repeat(32), tun = fakeTun();
    await setupPeer({ stateDir: state });
    let failed!: (line: string) => void;
    const observed = new Promise<string>((resolve) => { failed = resolve; });
    const dht = {
      stats: { punches: { consistent: 0, random: 0, open: 0 }, relaying: { attempts: 0, successes: 0, aborts: 0 } },
      createServer: () => ({ listen: async () => {}, close: async () => {} }),
      connect: () => {
        const stream = new streamx.Duplex({ read(callback) { callback(null); }, write(_data, callback) { callback(null); } });
        Object.assign(stream, { connected: false, remotePublicKey: Buffer.from(key, "hex") });
        const error = Object.assign(new Error(`PRIVATE_KEY ${key} PACKET_CONTENT`), { code: "PACKET_CONTENT" });
        queueMicrotask(() => stream.destroy(error));
        return stream;
      }, destroy: async () => {},
    } as unknown as DhtNode;
    running = await startVpn({ stateDir: state, helper: "fake", dht, openTun: async () => tun.device,
      config: { peers: [{ label: "remote", publicKey: key, connection: "dial" }],
        vpn: { address: "198.18.0.1", peers: [{ peer: "remote", address: "198.18.0.2", allowTcp: [] }] } },
      log: (line) => { if (line.includes("VPN dial to")) failed(line); },
    });
    assert.equal(await observed, "VPN dial to remote failed before transport connected: transport error");
  } finally { await running?.stop(); await rm(root, { recursive: true, force: true }); }
});
