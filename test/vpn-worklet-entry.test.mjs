import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("the worklet entry passes Bare.IPC to the bridge", async () => {
  const entry = new URL("../src/vpn/worklet-entry.ts", import.meta.url).href;
  const bridge = `data:text/javascript,${encodeURIComponent(
    "export function runWorkletBridge(ipc) { globalThis.__keposTestIPC = ipc; return Promise.resolve(); }",
  )}`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry && specifier === "./worklet-bridge.js") {
        return { url: bridge, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const ipc = {};
  const events = [];
  globalThis.Bare = { IPC: ipc, on(event) { events.push(event); }, exit() { throw new Error("unexpected exit"); } };
  try {
    await import(entry);
    assert.equal(globalThis.__keposTestIPC, ipc);
    assert.deepEqual(events, ["uncaughtException", "unhandledRejection"]);
  } finally {
    hooks.deregister();
    delete globalThis.Bare;
    delete globalThis.__keposTestIPC;
  }
});
