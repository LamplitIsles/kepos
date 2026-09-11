import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameDecoder, encodeFrame } from "../packages/bare-host-protocol/src/framing.js";
import type { HostEnvelope } from "../packages/bare-host-protocol/src/messages.js";
import { WorkletController } from "../packages/kepos-android-worklet/src/controller.js";

test("canonical Android Worklet answers ping and publishes peer status", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    status() {
      return {
        role: "peer",
        peerKey: "ab".repeat(32),
        connections: [],
        services: [],
        bindings: [],
      };
    },
    async stopEcho() {},
  });

  controller.start();
  await controller.receive(encodeFrame({ version: 1, kind: "request", id: 1, method: "ping" }));
  await controller.receive(encodeFrame({ version: 1, kind: "request", id: 2, method: "status" }));

  assert.deepEqual(output, [
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: {
        state: "running",
        runtimeId: "runtime-1",
        echoUrl: "http://127.0.0.1:17482/",
        role: "peer",
        peerKey: "ab".repeat(32),
        connections: [],
        services: [],
        bindings: [],
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
        role: "peer",
        peerKey: "ab".repeat(32),
        connections: [],
        services: [],
        bindings: [],
      },
    },
  ]);
});

test("Android Worklet republishes status only while running", () => {
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

  controller.publishStatus();
  assert.deepEqual(output, []);
  controller.start();
  output.length = 0;
  controller.publishStatus();
  assert.deepEqual(output, [{
    version: 1,
    kind: "event",
    event: "runtime.stateChanged",
    data: {
      state: "running",
      runtimeId: "runtime-1",
      echoUrl: "http://127.0.0.1:17482/",
    },
  }]);
  controller.start();
});

test("Android Worklet closes the canonical peer before acknowledging stop", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  let peerStopped = false;
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async stopEcho() {
      peerStopped = true;
    },
  });
  controller.start();
  await controller.receive(encodeFrame({ version: 1, kind: "request", id: 3, method: "stop" }));

  assert.equal(peerStopped, true);
  assert.deepEqual(output.slice(1), [
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: {
        state: "stopping",
        runtimeId: "runtime-1",
        echoUrl: "http://127.0.0.1:17482/",
      },
    },
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: {
        state: "stopped",
        runtimeId: "runtime-1",
        echoUrl: "http://127.0.0.1:17482/",
      },
    },
    {
      version: 1,
      kind: "response",
      id: 3,
      result: { stopped: true, runtimeId: "runtime-1" },
    },
  ]);
});

test("Android Worklet forwards canonical configuration and pairing operations", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  const configured: unknown[] = [];
  const paired: unknown[] = [];
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async configurePeer(publicKey, label, connection) {
      configured.push({ publicKey, label, connection });
      return { configured: true };
    },
    async pairPeer(invitation, deviceLabel, platform) {
      paired.push({ invitation, deviceLabel, platform });
      return { paired: true };
    },
    async stopEcho() {},
  });
  controller.start();
  output.length = 0;
  await controller.receive(encodeFrame({
    version: 1,
    kind: "request",
    id: 9,
    method: "configure",
    params: {
      publicKey: "ab".repeat(32),
      label: "phone",
      connection: "dial",
    },
  }));
  await controller.receive(encodeFrame({
    version: 1,
    kind: "request",
    id: 10,
    method: "pair",
    params: {
      invitation: "kepos://pair?v=1",
      deviceLabel: "Pixel",
      platform: "android",
    },
  }));

  assert.deepEqual(configured, [{
    publicKey: "ab".repeat(32),
    label: "phone",
    connection: "dial",
  }]);
  assert.deepEqual(paired, [{
    invitation: "kepos://pair?v=1",
    deviceLabel: "Pixel",
    platform: "android",
  }]);
  assert.deepEqual(
    output.filter((envelope) => envelope.kind === "response"),
    [
      {
        version: 1,
        kind: "response",
        id: 9,
        result: { configured: true },
      },
      {
        version: 1,
        kind: "response",
        id: 10,
        result: { paired: true },
      },
    ],
  );
});

test("Android Worklet rejects the obsolete role-specific configure field", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  let configured = false;
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async configurePeer() {
      configured = true;
    },
    async stopEcho() {},
  });
  controller.start();
  output.length = 0;

  await controller.receive(encodeFrame({
    version: 1,
    kind: "request",
    id: 11,
    method: "configure",
    params: { publisherKey: "ab".repeat(32) },
  }));

  assert.equal(configured, false);
  assert.deepEqual(output, [{
    version: 1,
    kind: "error",
    id: 11,
    error: {
      code: "invalid_configuration",
      message: "publicKey must be 32 bytes of lowercase hex",
    },
  }]);
});
