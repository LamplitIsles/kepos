// Test-only stand-in for the DHT used by the isolation harness.
//
// It replaces `createDht` through `startVpnEngine`'s `dht` option, so the
// engine never evaluates `createDht(...)` and this module never opens a socket.
// It says nothing about the rest of the process: other imports could still
// reach the network, and only an OS-level block could rule that out.

import type { PeerConfig } from "../../../../src/config.js";

export type FakeDhtMode = "success" | "reject" | "pending";

/** Counters the harness can assert on: no real DHT was ever constructed. */
export interface FakeDhtStats {
  createServer: number;
  connect: number;
  listen: number;
  close: number;
}

/**
 * The harness encodes the scenario in this device's synthetic overlay address,
 * which the fake DHT never uses for routing: `198.18.0.2` rejects the listen,
 * `198.18.0.3` leaves it pending, anything else resolves.
 */
export function modeForAddress(address: string): FakeDhtMode {
  const octets = address.split(".");
  const last = Number(octets[octets.length - 1]);
  if (last === 2) return "reject";
  if (last === 3) return "pending";
  return "success";
}

/** The scenario for a parsed worklet configuration. */
export function modeForConfig(config: PeerConfig): FakeDhtMode {
  return modeForAddress(config.vpn?.address ?? "");
}

/** The bootstrap hosts the parsed configuration asks the engine to contact. */
export function bootstrapHosts(config: PeerConfig): string[] {
  return (config.network?.bootstrap ?? []).map((entry) => entry.host);
}

/** The stream surface the engine uses on a dialled peer. */
export interface FakeStream {
  on(event: string, handler: (...args: unknown[]) => void): FakeStream;
  once(event: string, handler: (...args: unknown[]) => void): FakeStream;
  off(event: string, handler: (...args: unknown[]) => void): FakeStream;
  emit(event: string, ...args: unknown[]): boolean;
  destroy(): void;
  end(): void;
  write(): boolean;
  destroyed: boolean;
}

/** The server surface the engine uses for an accepted peer. */
export interface FakeServer extends FakeStream {
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** The DHT surface `startVpnEngine` uses. */
export interface FakeDht {
  stats: FakeDhtStats;
  createServer(): FakeServer;
  connect(): FakeStream;
  destroy(): Promise<void>;
}

function emitter<T extends FakeStream>(base: Omit<T, keyof FakeStream>): T {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const api = {
    on(event: string, handler: (...args: unknown[]) => void) {
      (handlers[event] ??= []).push(handler);
      return api;
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        api.off(event, wrapped);
        handler(...args);
      };
      return api.on(event, wrapped);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers[event] = (handlers[event] ?? []).filter((item) => item !== handler);
      return api;
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers[event] ?? []) handler(...args);
      return true;
    },
    destroy() {
      api.emit("close");
    },
    end() {},
    write() {
      return true;
    },
    destroyed: false,
    ...base,
  };
  return api as unknown as T;
}

/** A DHT whose server behaviour follows the requested scenario. */
export function fakeDht(mode: FakeDhtMode): { dht: FakeDht; stats: FakeDhtStats } {
  const stats: FakeDhtStats = { createServer: 0, connect: 0, listen: 0, close: 0 };
  const dht: FakeDht = {
    stats,
    createServer() {
      stats.createServer += 1;
      return emitter<FakeServer>({
        listen: async () => {
          stats.listen += 1;
          if (mode === "pending") return new Promise<void>(() => {});
          if (mode === "reject") throw new Error("fake dht listen rejected");
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        },
        close: async () => {
          stats.close += 1;
        },
      });
    },
    connect() {
      stats.connect += 1;
      return emitter<FakeStream>({});
    },
    destroy() {
      return Promise.resolve();
    },
  };
  return { dht, stats };
}

/** The DHT to inject for one parsed worklet configuration. */
export function fakeDhtFromConfig(config: PeerConfig): FakeDht {
  return fakeDht(modeForConfig(config)).dht;
}
