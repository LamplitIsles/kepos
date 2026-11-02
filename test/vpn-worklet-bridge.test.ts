import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { runWorkletBridge } from "../src/vpn/worklet-bridge.js";
import { IPC_CONTROL, IPC_PACKET, WorkletFraming } from "../src/vpn/worklet-framing.js";
import type { startVpnEngine } from "../src/vpn/engine.js";

class Linked extends Duplex {
  other?: Linked;
  override _read(): void {}
  override _write(data: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (!this.other || this.other.destroyed) return done(new Error("closed"));
    // Fragment every frame to exercise the byte-stream boundary.
    for (const byte of data) this.other.push(Buffer.from([byte]));
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

const seed = "07".repeat(32);
const remoteKey = "12".repeat(32);
const config = `[[peers]]\nlabel = "remote"\npublic_key = "${remoteKey}"\nconnection = "accept"\n[vpn]\naddress = "198.18.0.1"\npeers = [{ peer = "remote", address = "198.18.0.2", allow_tcp = [443] }]\n`;

test("worklet bridge waits for provider settings and forwards packets and peer state", async () => {
  const [client, server] = pair();
  const messages: Array<{ kind: number; payload: Buffer }> = [];
  let available!: () => void;
  const waiters: Array<() => void> = [];
  const receive = new WorkletFraming(client).receive(async (kind, payload) => {
    messages.push({ kind, payload: Buffer.from(payload) });
    waiters.shift()?.();
  });
  const next = async (): Promise<{ kind: number; payload: Buffer }> => {
    if (!messages.length) await new Promise<void>((resolve) => waiters.push(resolve));
    return messages.shift()!;
  };
  const send = new WorkletFraming(client);
  let deliver!: (packet: Buffer) => Promise<void>;
  let status!: NonNullable<Parameters<typeof startVpnEngine>[0]["onPeerStatus"]>;
  let stops = 0, starts = 0;
  const received: Buffer[] = [];
  const fakeEngine: typeof startVpnEngine = async (options) => {
    starts++;
    status = options.onPeerStatus!;
    const device = await options.openTun({ address: "198.18.0.1", peerAddresses: ["198.18.0.2"] });
    void device.packets.receive(async (packet) => { received.push(Buffer.from(packet)); });
    deliver = async (packet) => device.packets.send(packet);
    available?.();
    return { peerKey: "public", interfaceName: device.name, failed: new Promise<Error>(() => {}), stop: async () => {
      stops++;
      status({ key: remoteKey, label: "remote", connected: false });
      await device.close();
    } };
  };
  const running = runWorkletBridge(server, fakeEngine);
  try {
    await send.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", seed, config })));
    const settings = JSON.parse((await next()).payload.toString());
    assert.equal(settings.type, "settings");
    assert.equal(settings.address, "198.18.0.1");
    assert.deepEqual(settings.peers, [{ publicKey: remoteKey, label: "remote", address: "198.18.0.2", connected: false }]);
    assert.equal(starts, 0, "engine must wait until the provider applies its settings");
    const engineReady = new Promise<void>((resolve) => { available = resolve; });
    await send.send(IPC_CONTROL, Buffer.from('{"type":"ready"}'));
    await engineReady;
    assert.equal(JSON.parse((await next()).payload.toString()).type, "running");
    status({ key: remoteKey, label: "remote", connected: true });
    assert.deepEqual(JSON.parse((await next()).payload.toString()), { type: "peer", publicKey: remoteKey, label: "remote", connected: true });
    const packet = Buffer.alloc(40, 1);
    await send.send(IPC_PACKET, packet);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [packet]);
    await deliver(packet);
    assert.deepEqual(await next(), { kind: IPC_PACKET, payload: packet });
    await send.send(IPC_CONTROL, Buffer.from('{"type":"stop"}'));
    assert.deepEqual(JSON.parse((await next()).payload.toString()), { type: "peer", publicKey: remoteKey, label: "remote", connected: false });
    assert.equal(JSON.parse((await next()).payload.toString()).type, "stopped");
    assert.equal(stops, 1);
  } finally {
    client.destroy();
    await running;
    await receive.catch(() => undefined);
  }
});

test("worklet bridge rejects malformed startup without echoing secret input", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const messages: string[] = [];
  const received = frames.receive(async (_kind, payload) => { messages.push(payload.toString()); });
  const running = runWorkletBridge(server);
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", seed: "SECRET", config })));
  await running;
  await received.catch(() => undefined);
  // EOF can race the generic error reply; neither outcome may echo input.
  assert(messages.every((message) => message === '{"type":"error"}'));
});

test("worklet bridge rejects packets before network settings are applied", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const received = frames.receive(async () => {});
  let starts = 0;
  const fakeEngine: typeof startVpnEngine = async () => {
    starts++;
    throw new Error("must not start");
  };
  const running = runWorkletBridge(server, fakeEngine);
  await frames.send(IPC_PACKET, Buffer.alloc(40));
  await running;
  await received.catch(() => undefined);
  assert.equal(starts, 0);
});

test("stop acknowledgement waits for the engine to finish cleanup", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const replies: string[] = [];
  let wake!: () => void;
  const arrivals: Array<() => void> = [];
  const received = frames.receive(async (_kind, payload) => {
    replies.push(JSON.parse(payload.toString()).type);
    arrivals.shift()?.();
  });
  const next = async (): Promise<string> => {
    if (!replies.length) await new Promise<void>((resolve) => arrivals.push(resolve));
    return replies.shift()!;
  };
  let entered!: () => void;
  const stopping = new Promise<void>((resolve) => { entered = resolve; });
  const cleanup = new Promise<void>((resolve) => { wake = resolve; });
  const fakeEngine: typeof startVpnEngine = async () => ({
    peerKey: "public", interfaceName: "fake", failed: new Promise<Error>(() => {}),
    stop: async () => { entered(); await cleanup; },
  });
  const running = runWorkletBridge(server, fakeEngine);
  try {
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", seed, config })));
    assert.equal(await next(), "settings");
    await frames.send(IPC_CONTROL, Buffer.from('{"type":"ready"}'));
    assert.equal(await next(), "running");
    await frames.send(IPC_CONTROL, Buffer.from('{"type":"stop"}'));
    await stopping;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(replies, [], "the provider must not release its lock while cleanup is pending");
    wake();
    assert.equal(await next(), "stopped");
  } finally {
    wake(); client.destroy(); await running; await received.catch(() => undefined);
  }
});
