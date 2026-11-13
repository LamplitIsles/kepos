import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { runWorkletBridge } from "../src/vpn/worklet-bridge.js";
import { IPC_CONTROL, IPC_PACKET, WorkletFraming } from "../src/vpn/worklet-framing.js";
import { startVpnEngine } from "../src/vpn/engine.js";
import { PairError, type pairWithReceiver } from "../src/vpn/pair.js";
import { keyPairFromSeed } from "../src/mux/hyperdht.js";
import { parseKeposConfig } from "../src/config-toml.js";

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

test("pairing passes the invitation to the worklet and returns only public routing data", async () => {
  const [client, server] = pair();
  const secret = "ab".repeat(32);
  const invitation = `kepos1:${remoteKey}:${secret}`;
  const frames = new WorkletFraming(client);
  const messages: string[] = [];
  let paired!: () => void;
  let stopped!: () => void;
  const done = new Promise<void>((resolve) => { paired = resolve; });
  const stoppedMessage = new Promise<void>((resolve) => { stopped = resolve; });
  const receiving = frames.receive(async (_kind, payload) => {
    messages.push(payload.toString());
    if (JSON.parse(payload.toString()).type === "paired") paired();
    if (JSON.parse(payload.toString()).type === "stopped") stopped();
  });
  const fakePair: typeof pairWithReceiver = async (options) => {
    assert.equal(options.invitation, invitation);
    return { peers: [{ label: "receiver", publicKey: remoteKey, connection: "dial" }], vpn: { address: "198.18.113.9", peers: [{ peer: "receiver", address: "192.168.1.88", allowTcp: [] }] } };
  };
  const running = runWorkletBridge(server, undefined, fakePair);
  try {
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "pair", seed, invitation })));
    await done;
    assert.deepEqual(JSON.parse(messages[0]!), { type: "paired", address: "198.18.113.9", receiverAddress: "192.168.1.88", receiverKey: remoteKey });
    assert(!messages.join("").includes(secret));
    await frames.send(IPC_CONTROL, Buffer.from('{"type":"stop"}'));
    await stoppedMessage;
    client.destroy();
    await running;
  } finally { client.destroy(); await running; await receiving.catch(() => undefined); }
});

test("worklet forwards only a fixed pre-commit rejection category", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const secret = "ab".repeat(32);
  let received!: (value: string) => void;
  const reply = new Promise<string>((resolve) => { received = resolve; });
  const receiving = frames.receive(async (_kind, payload) => received(payload.toString()));
  const running = runWorkletBridge(server, undefined, async () => { throw new PairError("route"); });
  try {
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "pair", seed, invitation: `kepos1:${remoteKey}:${secret}` })));
    const result = await reply;
    assert.deepEqual(JSON.parse(result), { type: "pair-error", reason: "route" });
    assert(!result.includes(secret));
  } finally { client.destroy(); await running; await receiving.catch(() => undefined); }
});

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



// The shared bridge is single-use: `pair` moves it to `starting` and `stop`
// moves it to `stopped`, and neither allows another attempt. The Windows host
// therefore creates one worklet per attempt; these tests pin that contract.
test("a worklet cannot pair twice on the same bridge", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const messages: string[] = [];
  const received = frames.receive(async (_kind, payload) => { messages.push(payload.toString()); });
  const running = runWorkletBridge(server, undefined, async () => { throw new PairError("unusable"); });
  const invitation = `kepos1:${remoteKey}:${"ab".repeat(32)}`;
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "pair", seed, invitation })));
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "pair", seed, invitation })));
  await running.catch(() => undefined);
  await received.catch(() => undefined);
  // The first attempt answers; the second is refused. A generic error reply may
  // race the stream close, so the contract is "no second attempt was accepted".
  assert.deepEqual(JSON.parse(messages[0]!), { type: "pair-error", reason: "unusable" });
  assert(!messages.some((message) => message.includes('"paired"') || message.includes('"settings"')));
  assert(!messages.join("").includes("ab".repeat(32)));
});

test("a worklet cannot start again after it stopped", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const messages: string[] = [];
  const received = frames.receive(async (_kind, payload) => { messages.push(payload.toString()); });
  const fakeEngine: typeof startVpnEngine = async () => ({
    peerKey: remoteKey,
    interfaceName: "fixture",
    failed: new Promise<Error>(() => {}),
    stop: async () => {},
  });
  const running = runWorkletBridge(server, fakeEngine);
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", seed, config })));
  await frames.send(IPC_CONTROL, Buffer.from('{"type":"ready"}'));
  await frames.send(IPC_CONTROL, Buffer.from('{"type":"stop"}'));
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", seed, config })));
  await running.catch(() => undefined);
  await received.catch(() => undefined);
  // No second `settings`/`running`: the bridge refused the attempt. A generic
  // error reply may race the stream close and is not required.
  const types = messages.map((message) => JSON.parse(message).type);
  assert.deepEqual(types, ["settings", "running", "stopped"]);
});

test("the worklet reports the device public key for an identity query and never echoes the seed", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const messages: string[] = [];
  let consumed = 0;
  const waiters: Array<() => void> = [];
  const receiving = frames.receive(async (_kind, payload) => {
    messages.push(payload.toString());
    waiters.shift()?.();
  });
  // Wait for the next reply, whether it already arrived or not.
  const nextReply = async (): Promise<string> => {
    while (messages.length <= consumed) await new Promise<void>((resolve) => waiters.push(resolve));
    return messages[consumed++]!;
  };
  const running = runWorkletBridge(server);
  const expected = Buffer.from(keyPairFromSeed(seed).publicKey).toString("hex");
  try {
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "identity", seed })));
    assert.deepEqual(JSON.parse(await nextReply()), { type: "identity", publicKey: expected });
    // The query is stateless: asking again returns the same key.
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "identity", seed })));
    assert.deepEqual(JSON.parse(await nextReply()), { type: "identity", publicKey: expected });
    assert(!messages.join("").includes(seed));
    assert(!messages.join("").includes("seed"));
    client.destroy();
    await running;
  } finally { client.destroy(); await running; await receiving.catch(() => undefined); }
});

test("an identity query with unexpected fields is rejected without echoing the seed", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const messages: string[] = [];
  const received = frames.receive(async (_kind, payload) => { messages.push(payload.toString()); });
  const running = runWorkletBridge(server);
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "identity", seed, extra: true })));
  await running;
  await received.catch(() => undefined);
  assert(messages.every((message) => message === '{"type":"error"}'));
  assert(!messages.join("").includes(seed));
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

test("a failing engine after ready ends the stream without a running message", async () => {
  // Red loop for the Windows trace: settings -> ready accepted -> engine fails
  // -> bridge destroys the stream -> process has nothing left and exits 0.
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  let destroyed = false;
  client.on("close", () => { destroyed = true; });
  const failing = (async () => {
    throw new Error("dial failed");
  }) as unknown as typeof startVpnEngine;
  const bridge = runWorkletBridge(server, failing, (async () => { throw new PairError("unusable"); }) as unknown as typeof pairWithReceiver);
  const seen: string[] = [];
  const reader = new WorkletFraming(client);
  void reader.receive(async (kind, payload) => {
    if (kind === IPC_CONTROL) seen.push(JSON.parse(payload.toString("utf8")).type);
  }).catch(() => {});
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", config, seed })));
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "ready" })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(seen[0], "settings");
  assert.ok(!seen.includes("running"), "the bridge must not report running");
  assert.ok(destroyed, "the bridge must end the stream so the host sees EOF");
  await bridge.catch(() => {});
});

test("a failing startup is labelled in the existing error message", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const control: Record<string, unknown>[] = [];
  void new WorkletFraming(client).receive(async (kind, payload) => {
    if (kind === IPC_CONTROL) control.push(JSON.parse(payload.toString("utf8")));
  }).catch(() => {});
  const failing = (async () => {
    throw new Error("listen failed");
  }) as unknown as typeof startVpnEngine;
  const bridge = runWorkletBridge(server, failing, (async () => { throw new PairError("unusable"); }) as unknown as typeof pairWithReceiver);
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", config, seed })));
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "ready" })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const error = control.find((message) => message.type === "error");
  assert.ok(error, "the bridge must report a failure");
  assert.equal(error.stage, "startup");
  // The label is fixed and carries no detail from the thrown error.
  assert.deepEqual(Object.keys(error).sort(), ["stage", "type"]);
  await bridge.catch(() => {});
});

test("the last real call boundary is labelled, not a blanket startup", async () => {
  const start = async (engine: (options: Parameters<typeof startVpnEngine>[0]) => ReturnType<typeof startVpnEngine>): Promise<Record<string, unknown> | undefined> => {
    const [client, server] = pair();
    const frames = new WorkletFraming(client);
    const control: Record<string, unknown>[] = [];
    void new WorkletFraming(client).receive(async (kind, payload) => {
      if (kind === IPC_CONTROL) control.push(JSON.parse(payload.toString("utf8")));
    }).catch(() => {});
    const bridge = runWorkletBridge(server, engine, (async () => { throw new PairError("unusable"); }) as unknown as typeof pairWithReceiver);
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", config, seed }))).catch(() => undefined);
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "ready" }))).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await bridge.catch(() => {});
    return control.find((message) => message.type === "error");
  };

  const tun = { name: "packetFlow", packets: { send: async () => {}, receive: async () => {} }, closed: new Promise<Error>(() => {}), close: async () => {} };
  const dht = (listen: () => Promise<void>) => ({
    connect: () => { throw new Error("unused"); },
    createServer: () => ({ close: async () => {}, listen }),
    stats: {},
    destroy: async () => {},
  });

  // A rejected listen is labelled listen.
  const listenFailure = await start(((options: Parameters<typeof startVpnEngine>[0]) => startVpnEngine({
    ...options, dht: dht(async () => { throw new Error("listen failed"); }) as never, openTun: async () => tun,
  })) as unknown as typeof startVpnEngine);
  // The catch now reports the failure boundary itself.
  assert.equal(listenFailure?.stage, "listen-reject");

  // A rejected openTun is labelled tun, not listen.
  const tunFailure = await start(((options: Parameters<typeof startVpnEngine>[0]) => startVpnEngine({
    ...options, dht: dht(async () => {}) as never, openTun: async () => { throw new Error("tun failed"); },
  })) as unknown as typeof startVpnEngine);
  assert.equal(tunFailure?.stage, "startup-reject");

  // Configuration validation happens inside the engine, after the bridge has
  // already sent settings: the stage sequence proves the ordering.
  const stages: string[] = [];
  const badConfig = parseKeposConfig(`[[peers]]\nlabel = "remote"\npublic_key = "${remoteKey}"\nconnection = "accept"\n[vpn]\naddress = "198.18.0.1"\npeers = [{ peer = "remote", address = "198.18.0.2" }]\n`);
  await startVpnEngine({
    config: badConfig, keyPair: keyPairFromSeed(seed), now: () => Date.now(),
    dht: dht(async () => { throw new Error("listen failed"); }) as never,
    openTun: async () => tun, stage: (reached) => stages.push(reached),
  }).then(async (running) => { await running.stop(); }, () => undefined);
  assert.deepEqual(stages.slice(0, 5), ["config", "peers", "tun", "dht", "listen"]);
  assert.ok(stages.includes("listen-reject"), `missing reject label: ${stages.join(",")}`);
});

test("stage diagnostics are sent only to a host that opts in", async () => {
  const run = async (caps?: string[]) => {
    const [client, server] = pair();
    const frames = new WorkletFraming(client);
    const control: Record<string, unknown>[] = [];
    void new WorkletFraming(client).receive(async (kind, payload) => {
      if (kind === IPC_CONTROL) control.push(JSON.parse(payload.toString("utf8")));
    }).catch(() => {});
    const tun = { name: "packetFlow", packets: { send: async () => {}, receive: async () => {} }, closed: new Promise<Error>(() => {}), close: async () => {} };
    const dht = { connect: () => { throw new Error("unused"); }, createServer: () => ({ close: async () => {}, listen: async () => { throw new Error("listen failed"); } }), stats: {}, destroy: async () => {} };
    const engine = ((options: Parameters<typeof startVpnEngine>[0]) => startVpnEngine({ ...options, dht: dht as never, openTun: async () => tun })) as unknown as typeof startVpnEngine;
    const bridge = runWorkletBridge(server, engine, (async () => { throw new PairError("unusable"); }) as unknown as typeof pairWithReceiver);
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", config, seed, ...(caps ? { caps } : {}) }))).catch(() => undefined);
    await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "ready" }))).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await bridge.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    return control.filter((message) => message.type === "diag").flatMap((message) => (message.stages as string[]) ?? [message.stage]);
  };

  // Opted in, failing path: the failure itself carries the stage. The trailing
  // burst is best effort and may be dropped once the stream is being torn down,
  // so only the pre-failure diagnostic is guaranteed here.
  assert.deepEqual(await run(["diag"]), ["settings-sent"]);
  // A host that does not opt in receives no diagnostic frames at all.
  assert.deepEqual(await run(), []);
});

test("progress is observable while a stage hangs, not only on failure", async () => {
  const [client, server] = pair();
  const frames = new WorkletFraming(client);
  const control: Record<string, unknown>[] = [];
  void new WorkletFraming(client).receive(async (kind, payload) => {
    if (kind === IPC_CONTROL) control.push(JSON.parse(payload.toString("utf8")));
  }).catch(() => {});
  const tun = { name: "packetFlow", packets: { send: async () => {}, receive: async () => {} }, closed: new Promise<Error>(() => {}), close: async () => {} };
  // listen never settles: the trace must still show that it was entered.
  const dht = { connect: () => { throw new Error("unused"); }, createServer: () => ({ close: async () => {}, listen: () => new Promise<void>(() => {}) }), stats: {}, destroy: async () => {} };
  const engine = ((options: Parameters<typeof startVpnEngine>[0]) => startVpnEngine({ ...options, dht: dht as never, openTun: async () => tun })) as unknown as typeof startVpnEngine;
  const bridge = runWorkletBridge(server, engine, (async () => { throw new PairError("unusable"); }) as unknown as typeof pairWithReceiver);
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "start", config, seed, caps: ["diag"] }))).catch(() => undefined);
  await frames.send(IPC_CONTROL, Buffer.from(JSON.stringify({ type: "ready" }))).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stages = control.filter((message) => message.type === "diag").flatMap((message) => (message.stages as string[]) ?? [message.stage]);
  // Observed before any failure or shutdown: the host can see live progress.
  assert.deepEqual(stages, ["settings-sent", "ready", "config", "peers", "tun", "dht", "listen"]);
  assert.ok(!control.some((message) => message.type === "running"), "a hanging listen must not report running");
  assert.ok(!control.some((message) => message.type === "error"), "a hanging listen has not failed yet");
  // Nothing is destroyed while the stage is pending.
  assert.ok(!client.destroyed && !server.destroyed);
  client.destroy(); server.destroy();
  // The bridge cannot settle while the stage hangs; do not wait for it.
  void bridge.catch(() => undefined);
});

test("listen and cleanup stages are reported in order", async () => {
  const tun = { name: "packetFlow", packets: { send: async () => {}, receive: async () => {} }, closed: new Promise<Error>(() => {}), close: async () => {} };
  const run = async (listen: () => Promise<void>, close: () => Promise<void>) => {
    const stages: string[] = [];
    const dht = { connect: () => { throw new Error("unused"); }, createServer: () => ({ listen, close }), stats: {}, destroy: async () => {} };
    await startVpnEngine({
      config: parseKeposConfig(config), keyPair: keyPairFromSeed(seed), now: () => Date.now(),
      dht: dht as never, openTun: async () => tun, stage: (s) => stages.push(s),
    }).then(async (running) => { await running.stop(); }, () => undefined);
    return stages;
  };
  // Success: listen returned, so no reject and no cleanup from the failure path.
  const ok = await run(async () => {}, async () => {});
  assert.deepEqual(ok, ["config", "peers", "tun", "dht", "listen", "listen-return", "cleanup-begin", "cleanup-end"]);
  // Rejection with working cleanup: the failure is labelled before cleanup runs.
  const rejected = await run(async () => { throw new Error("listen failed"); }, async () => {});
  assert.deepEqual(rejected, ["config", "peers", "tun", "dht", "listen", "listen-reject", "cleanup-begin", "cleanup-end"]);
});

test("a cleanup that never finishes is visible as cleanup-begin without cleanup-end", async () => {
  const stages: string[] = [];
  const tun = { name: "packetFlow", packets: { send: async () => {}, receive: async () => {} }, closed: new Promise<Error>(() => {}), close: async () => {} };
  const dht = {
    connect: () => { throw new Error("unused"); },
    // listen rejects, and the server close never settles.
    createServer: () => ({ listen: async () => { throw new Error("listen failed"); }, close: () => new Promise<void>(() => {}) }),
    stats: {}, destroy: async () => {},
  };
  const pending = startVpnEngine({
    config: parseKeposConfig(config), keyPair: keyPairFromSeed(seed), now: () => Date.now(),
    dht: dht as never, openTun: async () => tun, stage: (s) => stages.push(s),
  });
  const outcome = await Promise.race([
    pending.then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("still-pending"), 150)),
  ]);
  assert.equal(outcome, "still-pending", "the engine must not settle while cleanup hangs");
  assert.equal(stages.at(-1), "cleanup-begin");
  assert.ok(!stages.includes("cleanup-end"), `unexpected cleanup-end: ${stages.join(",")}`);
  assert.ok(stages.includes("listen-reject"), `missing reject label: ${stages.join(",")}`);
});
