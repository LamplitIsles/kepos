import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameDecoder, encodeFrame } from "../packages/bare-host-protocol/src/framing.js";
import type { HostEnvelope } from "../packages/bare-host-protocol/src/messages.js";
import { WorkletController } from "../packages/kepos-android-worklet/src/controller.js";

test("Android Worklet controller answers ping and status", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async stopEcho() {},
  });

  controller.start();
  await controller.receive(
    encodeFrame({ version: 1, kind: "request", id: 1, method: "ping" }),
  );
  await controller.receive(
    encodeFrame({ version: 1, kind: "request", id: 2, method: "status" }),
  );

  assert.deepEqual(output, [
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: {
        state: "running",
        runtimeId: "runtime-1",
        echoUrl: "http://127.0.0.1:17482/",
      },
    },
    {
      version: 1,
      kind: "response",
      id: 1,
      result: { pong: true, runtimeId: "runtime-1" },
    },
    {
      version: 1,
      kind: "response",
      id: 2,
      result: {
        state: "running",
        runtimeId: "runtime-1",
        echoUrl: "http://127.0.0.1:17482/",
      },
    },
  ]);
});

test("Android Worklet controller closes echo before acknowledging stop", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  let echoStopped = false;
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async stopEcho() {
      echoStopped = true;
    },
  });
  controller.start();

  await controller.receive(
    encodeFrame({ version: 1, kind: "request", id: 3, method: "stop" }),
  );

  assert.equal(echoStopped, true);
  assert.deepEqual(output.slice(1), [
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: { state: "stopping", runtimeId: "runtime-1" },
    },
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: { state: "stopped", runtimeId: "runtime-1" },
    },
    {
      version: 1,
      kind: "response",
      id: 3,
      result: { stopped: true, runtimeId: "runtime-1" },
    },
  ]);
});

test("Android Worklet controller configures one publisher without stopping", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  let configuredKey: string | undefined;
  let stopped = false;
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async stopEcho() {
      stopped = true;
    },
    async configurePublisher(publisherKey: string) {
      configuredKey = publisherKey;
      return { connection: "connecting" };
    },
    status() {
      return {
        subscriberPublicKey: "cd".repeat(32),
        connection: configuredKey ? "connecting" : "offline",
        homeUrl: "http://home.localhost:17480/",
        navidromeUrl: "http://navidrome.localhost:17480/",
      };
    },
  });
  controller.start();

  await controller.receive(
    encodeFrame({
      version: 1,
      kind: "request",
      id: 4,
      method: "configure",
      params: { publisherKey: "ab".repeat(32) },
    }),
  );

  assert.equal(configuredKey, "ab".repeat(32));
  assert.equal(stopped, false);
  assert.deepEqual(output.at(-2), {
    version: 1,
    kind: "event",
    event: "runtime.stateChanged",
    data: {
      state: "running",
      runtimeId: "runtime-1",
      echoUrl: "http://127.0.0.1:17482/",
      subscriberPublicKey: "cd".repeat(32),
      connection: "connecting",
      homeUrl: "http://home.localhost:17480/",
      navidromeUrl: "http://navidrome.localhost:17480/",
    },
  });
  assert.deepEqual(output.at(-1), {
    version: 1,
    kind: "response",
    id: 4,
    result: { connection: "connecting" },
  });

  await controller.receive(
    encodeFrame({ version: 1, kind: "request", id: 5, method: "status" }),
  );
  assert.deepEqual(output.at(-1), {
    version: 1,
    kind: "response",
    id: 5,
    result: {
      state: "running",
      runtimeId: "runtime-1",
      echoUrl: "http://127.0.0.1:17482/",
      subscriberPublicKey: "cd".repeat(32),
      connection: "connecting",
      homeUrl: "http://home.localhost:17480/",
      navidromeUrl: "http://navidrome.localhost:17480/",
    },
  });

  configuredKey = undefined;
  controller.publishStatus();
  assert.equal(
    (output.at(-1) as { data?: { connection?: string } }).data?.connection,
    "offline",
  );
});

test("Android Worklet controller forwards one pairing invitation", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  let received: unknown;
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async stopEcho() {},
    async pairPublisher(invitation, deviceLabel, platform) {
      received = { invitation, deviceLabel, platform };
      return { connection: "connected" };
    },
  });
  controller.start();

  const textEncoder = globalThis.TextEncoder;
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: undefined,
  });
  try {
    await controller.receive(
      encodeFrame({
        version: 1,
        kind: "request",
        id: 5,
        method: "pair",
        params: {
          invitation: "kepos://pair?v=1&token=one-time",
          deviceLabel: "Neil's Pixel",
          platform: "android",
        },
      }),
    );
  } finally {
    Object.defineProperty(globalThis, "TextEncoder", {
      configurable: true,
      value: textEncoder,
    });
  }

  assert.deepEqual(received, {
    invitation: "kepos://pair?v=1&token=one-time",
    deviceLabel: "Neil's Pixel",
    platform: "android",
  });
  assert.deepEqual(output.at(-1), {
    version: 1,
    kind: "response",
    id: 5,
    result: { connection: "connected" },
  });
});

test("Android Worklet controller serializes concurrent publisher configuration", async () => {
  const decoder = new FrameDecoder();
  const configured: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      decoder.push(frame);
    },
    async stopEcho() {},
    async configurePublisher(publisherKey) {
      configured.push(publisherKey);
      if (configured.length === 1) await firstBlocked;
      return { connection: "connecting" };
    },
  });
  controller.start();

  const first = controller.receive(
    encodeFrame({
      version: 1,
      kind: "request",
      id: 6,
      method: "configure",
      params: { publisherKey: "ab".repeat(32) },
    }),
  );
  await Promise.resolve();
  const second = controller.receive(
    encodeFrame({
      version: 1,
      kind: "request",
      id: 7,
      method: "configure",
      params: { publisherKey: "cd".repeat(32) },
    }),
  );
  await Promise.resolve();

  try {
    assert.deepEqual(configured, ["ab".repeat(32)]);
  } finally {
    releaseFirst?.();
    await Promise.all([first, second]);
  }
  assert.deepEqual(configured, ["ab".repeat(32), "cd".repeat(32)]);
});
