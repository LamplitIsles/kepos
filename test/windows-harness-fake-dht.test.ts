import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import { parseKeposConfig } from "../src/config-toml.js";
import { startVpnEngine } from "../src/vpn/engine.js";
import { runWorkletBridge } from "../src/vpn/worklet-bridge.js";
import type { DhtNode } from "../src/mux/hyperdht.js";
import {
  bootstrapHosts,
  fakeDht,
  fakeDhtFromConfig,
  modeForAddress,
  modeForConfig,
} from "../apps/windows/kepos-vpn/worklet/fake-dht.js";

const RECEIVER_KEY = "22".repeat(32);
const SEED = "11".repeat(32);

function configFor(address: string): string {
  return (
    `peers = [{ label = "receiver", public_key = "${RECEIVER_KEY}", connection = "dial" }]\n` +
    `[vpn]\naddress = "${address}"\npeers = [{ peer = "receiver", address = "198.18.0.254", allow_tcp = [] }]\n` +
    `[network]\nbootstrap = ["127.0.0.1:4711"]\n`
  );
}

/** Encode one control frame exactly as the host does. */
function controlFrame(value: object): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const length = payload.length + 1;
  return Buffer.concat([Buffer.from([length >> 8, length & 0xff, 1]), payload]);
}

/** Encode one packet frame exactly as the host does. */
function packetFrame(packet: Buffer): Buffer {
  const length = packet.length + 1;
  return Buffer.concat([Buffer.from([length >> 8, length & 0xff, 2]), packet]);
}

/** A minimal but well-formed IPv4 header with no payload. */
function ipv4Header(): Buffer {
  const header = Buffer.alloc(20);
  header[0] = 0x45;
  header.writeUInt16BE(20, 2);
  header[8] = 64;
  header[9] = 17;
  header.writeUInt16BE(0x1234, 4);
  return header;
}

/** Decode every complete control frame in a byte buffer. */
function controlMessages(bytes: Buffer): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const length = bytes.readUInt16BE(offset);
    if (offset + 2 + length > bytes.length) break;
    const kind = bytes[offset + 2]!;
    const payload = bytes.subarray(offset + 3, offset + 2 + length);
    if (kind === 1) messages.push(JSON.parse(payload.toString()) as Record<string, unknown>);
    offset += 2 + length;
  }
  return messages;
}

/** Run the real bridge with the fake DHT for one parsed configuration. */
async function runScenario(
  address: string,
  options: { packetBeforeRunning?: boolean } = {},
): Promise<{
  messages: Record<string, unknown>[];
  stats: { createServer: number; listen: number };
  destroyed: boolean;
}> {
  let received = Buffer.alloc(0);
  let readySent = false;
  const host: Duplex = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      received = Buffer.concat([received, Buffer.from(chunk)]);
      if (!readySent && controlMessages(received).some((message) => message.type === "settings")) {
        readySent = true;
        host.push(controlFrame({ type: "ready" }));
        if (options.packetBeforeRunning) {
          // A well-formed IPv4 packet (20-byte header, version 4, IHL 5) sent
          // while the bridge is still in `starting`.
          host.push(packetFrame(ipv4Header()));
        }
      }
      done();
    },
  });
  let stats = { createServer: 0, listen: 0 };
  const startEngine: typeof startVpnEngine = (options) => {
    const dht = fakeDhtFromConfig(options.config);
    stats = dht.stats;
    return startVpnEngine({ ...options, dht: dht as unknown as DhtNode });
  };

  const bridged = runWorkletBridge(host, startEngine);
  host.push(controlFrame({ type: "start", config: configFor(address), seed: SEED, caps: ["diag"] }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  host.destroy();
  // A pending listen never settles, so the bridge cannot be awaited to
  // completion; the observation window is what the test asserts on.
  await Promise.race([bridged.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 250))]);
  return { messages: controlMessages(received), stats, destroyed: host.destroyed };
}

describe("harness fake DHT", () => {
  it("maps the synthetic overlay address to a scenario", () => {
    expect(modeForAddress("198.18.0.1")).toBe("success");
    expect(modeForAddress("198.18.0.2")).toBe("reject");
    expect(modeForAddress("198.18.0.3")).toBe("pending");
    expect(modeForAddress("")).toBe("success");
  });

  it("reads the scenario and bootstrap from the parsed configuration", () => {
    const config = parseKeposConfig(configFor("198.18.0.2"));
    expect(modeForConfig(config)).toBe("reject");
    expect(bootstrapHosts(config)).toEqual(["127.0.0.1"]);
    expect(modeForConfig(parseKeposConfig(configFor("198.18.0.3")))).toBe("pending");
    expect(modeForConfig(parseKeposConfig(configFor("198.18.0.1")))).toBe("success");
  });

  it("resolves listen on success and counts every call", async () => {
    const { dht, stats } = fakeDht("success");
    const server = dht.createServer();
    await server.listen();
    await server.close();
    expect(stats).toEqual({ createServer: 1, connect: 0, listen: 1, close: 1 });
  });

  it("rejects listen on reject and never settles it on pending", async () => {
    const rejected = fakeDht("reject").dht.createServer();
    await expect(rejected.listen()).rejects.toThrow(/listen rejected/);

    const pending = fakeDht("pending").dht.createServer();
    const outcome = await Promise.race([
      pending.listen().then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(outcome).toBe("pending");
  });

  it("runs the real bridge to running on the success scenario", async () => {
    const { messages, stats } = await runScenario("198.18.0.1");
    const types = messages.map((message) => message.type);
    expect(types).toContain("settings");
    expect(types).toContain("running");
    expect(stats.listen).toBe(1);
  });

  it("runs the real bridge to a listen error on the reject scenario", async () => {
    const { messages } = await runScenario("198.18.0.2");
    const types = messages.map((message) => message.type);
    expect(types).toContain("settings");
    expect(types).toContain("error");
    expect(messages.find((message) => message.type === "error")?.stage).toBe("listen-reject");
    expect(types).not.toContain("running");
  });

  it("closes the stream silently when a packet arrives before the engine is running", async () => {
    // Observed behaviour, not desired behaviour: the packet makes the bridge
    // throw, the async iterator destroys the stream before the catch runs, and
    // the `!stream.destroyed` guard then skips the error frame. The host sees a
    // silent close. The Windows runtime no longer sends packets this early.
    const { messages, destroyed } = await runScenario("198.18.0.3", { packetBeforeRunning: true });
    const types = messages.map((message) => message.type);
    expect(types).toContain("settings");
    expect(types).not.toContain("running");
    expect(types).not.toContain("error");
    expect(destroyed).toBe(true);
  });

  it("keeps the real bridge waiting on the pending scenario", async () => {
    const { messages } = await runScenario("198.18.0.3");
    const types = messages.map((message) => message.type);
    expect(types).toContain("settings");
    expect(types).not.toContain("running");
    expect(types).not.toContain("error");
  });
});
