// Test-only worklet entry for the Windows isolation harness.
//
// The real bridge, the real framing and the real IPC run unchanged; only the
// DHT is replaced, so the engine never creates a real one. Nothing here is
// part of the shipped bundle.

import type { Duplex } from "node:stream";

import { startVpnEngine } from "../../../../src/vpn/engine.js";
import { runWorkletBridge } from "../../../../src/vpn/worklet-bridge.js";
import type { DhtNode } from "../../../../src/mux/hyperdht.js";
import { fakeDhtFromConfig } from "./fake-dht.js";

declare const Bare: { IPC: unknown; exit(n: number): never };

const startEngine: typeof startVpnEngine = (options) =>
  startVpnEngine({ ...options, dht: fakeDhtFromConfig(options.config) as unknown as DhtNode });

void runWorkletBridge(Bare.IPC as unknown as Duplex, startEngine).catch(() => Bare.exit(1));
