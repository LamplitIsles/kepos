import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";

import {
  DEFAULT_GATEWAY_PORT,
  startHttpGateway,
} from "../src/home/gateway.js";

test("HTTP gateway has a fixed default port", () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 17_480);
});

test("HTTP gateway binds to loopback unless a host is explicit", async () => {
  const loopback = await startHttpGateway({
    port: 0,
    open: async () => new Promise<never>(() => undefined),
  });
  const exposed = await startHttpGateway({
    port: 0,
    host: "0.0.0.0",
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    assert.deepEqual(loopback.server.address(), {
      address: "127.0.0.1",
      family: "IPv4",
      port: loopback.port,
    });
    assert.deepEqual(exposed.server.address(), {
      address: "0.0.0.0",
      family: "IPv4",
      port: exposed.port,
    });
  } finally {
    await Promise.all([closeGateway(loopback), closeGateway(exposed)]);
  }
});

test("HTTP gateway adds one configured domain without losing localhost", async () => {
  const gateway = await startHttpGateway({
    port: 0,
    domain: "kepos.internal",
    acquisitionTimeoutMs: 5,
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    const [podStatus, nodeStatus, unrelatedStatus] = await Promise.all([
      requestStatus(gateway.port, "navidrome.kepos.internal"),
      requestStatus(gateway.port, "navidrome.localhost"),
      requestStatus(gateway.port, "navidrome.example.com"),
    ]);
    assert.equal(podStatus, 503);
    assert.equal(nodeStatus, 503);
    assert.equal(unrelatedStatus, 421);
  } finally {
    await closeGateway(gateway);
  }
});

test("HTTP gateway does not accept a private domain by default", async () => {
  const gateway = await startHttpGateway({
    port: 0,
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    assert.equal(
      await requestStatus(gateway.port, "navidrome.kepos.internal"),
      421,
    );
  } finally {
    await closeGateway(gateway);
  }
});

test("HTTP gateway reports unavailable when tunnel acquisition times out", async () => {
  const gateway = await startHttpGateway({
    port: 0,
    acquisitionTimeoutMs: 5,
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    const response = await fetch(
      `http://navidrome.localhost:${gateway.port}/rest/ping`,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
  } finally {
    await closeGateway(gateway);
  }
});

async function closeGateway(
  gateway: Awaited<ReturnType<typeof startHttpGateway>>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    gateway.server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestStatus(port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port,
      headers: { host },
    });
    outgoing.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
