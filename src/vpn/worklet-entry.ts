import type { Duplex } from "node:stream";
import { runWorkletBridge } from "./worklet-bridge.js";

declare const BareKit: { IPC: Duplex };
declare const Bare: {
  on: (event: "uncaughtException" | "unhandledRejection", handler: () => void) => void;
  exit: (code: number) => never;
};

// A worklet shares the provider process. Never print uncaught values: they can
// contain configuration or key material. Exiting closes IPC and fails the VPN.
Bare.on("uncaughtException", () => Bare.exit(1));
Bare.on("unhandledRejection", () => Bare.exit(1));
void runWorkletBridge(BareKit.IPC).catch(() => Bare.exit(1));
