import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Duplex, Transform } from "node:stream";
import { test } from "node:test";

import {
  createPeerMetricsRecorder,
  peerMetricNames,
  type PeerMetricsContext,
  type PeerMetricsPolicy,
} from "../src/metrics/peer.js";
import { startMetricsServer } from "../src/metrics/server.js";
import { createMuxPeer } from "../src/mux/transport.js";

const phoneKey = "22".repeat(32);
const tabletKey = "33".repeat(32);

function policy(
  peers: PeerMetricsPolicy["peers"] = [
    { label: "phone", publicKey: phoneKey },
    { label: "tablet", publicKey: tabletKey },
  ],
): PeerMetricsPolicy {
  return {
    peers,
    services: [
      { id: "private", allow: [phoneKey] },
      { id: "ssh", allow: [phoneKey] },
    ],
  };
}

function context(connectionId: string, subscriberKey = phoneKey): PeerMetricsContext {
  return { subscriberKey, connectionId };
}

test("peer metrics preserve the shipped series, labels, lifecycle, and policy state", () => {
  let now = 1_700_000_000_000;
  const recorder = createPeerMetricsRecorder(policy(), () => now);
  let exposition = recorder.render();

  for (const name of peerMetricNames) {
    assert.match(exposition, new RegExp(`# HELP ${name} `));
    assert.match(exposition, new RegExp(`# TYPE ${name} `));
  }
  assert.match(
    exposition,
    /kepos_publisher_subscriber_connected\{subscriber_id="2222222222222222",subscriber_label="phone"\} 0/,
  );
  assert.match(
    exposition,
    /service_authorized\{service="private",subscriber_id="2222222222222222",subscriber_label="phone"\} 1/,
  );
  assert.match(
    exposition,
    /service_authorized\{service="private",subscriber_id="3333333333333333",subscriber_label="tablet"\} 0/,
  );
  assert.doesNotMatch(exposition, new RegExp(phoneKey));

  recorder.connectionActivated(context("outer-1"));
  now += 5_000;
  recorder.serviceChannelOpened(context("outer-1"), "ssh");
  recorder.serviceBytes(context("outer-1"), "ssh", "subscriber_to_publisher", 5);
  recorder.serviceBytes(context("outer-1"), "ssh", "publisher_to_subscriber", 7);
  exposition = recorder.render();
  assert.match(exposition, /subscriber_connected\{[^}]+\} 1/);
  assert.match(exposition, /service_active_channels\{service="ssh"[^}]+\} 1/);
  assert.match(exposition, /subscriber_connection_bytes\{direction="subscriber_to_publisher"[^}]+\} 5/);
  assert.match(exposition, /service_bytes_total\{direction="publisher_to_subscriber",service="ssh"[^}]+\} 7/);

  recorder.connectionActivated(context("outer-2"));
  exposition = recorder.render();
  assert.match(exposition, /subscriber_connection_bytes\{direction="subscriber_to_publisher"[^}]+\} 0/);
  assert.match(exposition, /subscriber_bytes_total\{direction="subscriber_to_publisher"[^}]+\} 5/);
  recorder.connectionClosed(context("outer-1"));
  assert.match(recorder.render(), /subscriber_connected\{[^}]+\} 1/);
  recorder.connectionClosed(context("outer-2"));
  exposition = recorder.render();
  assert.match(exposition, /subscriber_connected\{[^}]+\} 0/);
  assert.match(exposition, /last_connected_timestamp_seconds\{[^}]+\} 1700000005/);

  recorder.connectionActivated(context("outer-3"));
  recorder.serviceChannelOpened(context("outer-3"), "private");
  recorder.serviceBytes(context("outer-3"), "private", "subscriber_to_publisher", 23);
  recorder.applyPolicy({
    peers: policy().peers,
    services: [
      { id: "private", allow: [tabletKey] },
      { id: "ssh", allow: [phoneKey] },
    ],
  });
  exposition = recorder.render();
  assert.match(exposition, /service_authorized\{service="private",subscriber_id="2222222222222222"[^}]*\} 0/);
  assert.match(exposition, /service_active_channels\{service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 1/);
  assert.match(exposition, /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 23/);
  recorder.serviceBytes(context("stale"), "private", "subscriber_to_publisher", 99);
  recorder.serviceBytes(context("outer-3"), "private", "subscriber_to_publisher", 11);
  assert.match(recorder.render(), /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 34/);
  recorder.serviceChannelClosed(context("outer-3"), "private");
  recorder.serviceBytes(context("outer-3"), "private", "subscriber_to_publisher", 7);
  assert.match(recorder.render(), /service_active_channels\{service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 0/);
  assert.match(recorder.render(), /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 34/);

  recorder.applyPolicy({ peers: [{ label: "phone", publicKey: phoneKey }], services: [] });
  recorder.applyPolicy(policy());
  exposition = recorder.render();
  assert.match(exposition, /subscriber_label="phone"[^}]*\} 0/);
  assert.doesNotMatch(exposition, /service="private"[^\n]*34/);
  assert.match(exposition, /subscriber_label="tablet"[^}]*\} 0/);
});

test("peer metrics endpoint is read-only and has an idempotent lifecycle", async () => {
  const server = await startMetricsServer({
    listen: { host: "127.0.0.1", port: 0 },
    render: () => "# TYPE kepos_test gauge\nkepos_test 1\n",
  });
  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(await response.text(), /kepos_test 1/);
  assert.equal((await fetch(`${server.url}/other`)).status, 404);
  assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
  await server.close();
  await server.close();
  await assert.rejects(() => fetch(server.url));
});

test("peer metrics listener releases a failed bind", async () => {
  const occupied = await startMetricsServer({
    listen: { host: "127.0.0.1", port: 0 },
    render: () => "# TYPE kepos_test gauge\nkepos_test 1\n",
  });
  try {
    await assert.rejects(
      startMetricsServer({
        listen: { host: "127.0.0.1", port: occupied.port },
        render: () => "",
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EADDRINUSE",
    );
  } finally {
    await occupied.close();
  }
});

test("peer metrics reject stale events and render endpoint failures safely", async () => {
  const recorder = createPeerMetricsRecorder(policy());
  recorder.connectionActivated(context("outer-1"));
  recorder.serviceChannelOpened(context("outer-1"), "ssh");
  recorder.serviceChannelOpened(context("outer-1"), "ssh");
  recorder.serviceChannelClosed(context("outer-1"), "ssh");
  recorder.serviceChannelClosed(context("outer-1"), "ssh");
  recorder.serviceChannelClosed(context("outer-1"), "ssh");
  recorder.connectionActivated(context("missing", "44".repeat(32)));
  recorder.connectionClosed(context("missing", "44".repeat(32)));
  recorder.serviceChannelOpened(context("outer-1"), "missing");
  recorder.serviceChannelOpened(context("stale"), "ssh");
  recorder.serviceBytes(context("missing"), "ssh", "subscriber_to_publisher", 1);
  recorder.serviceBytes(context("outer-1"), "missing", "subscriber_to_publisher", 1);
  recorder.serviceBytes(context("outer-1"), "ssh", "subscriber_to_publisher", -1);
  recorder.serviceBytes(context("outer-1"), "ssh", "subscriber_to_publisher", Number.NaN);
  recorder.applyPolicy({ peers: policy().peers, services: [] });
  assert.doesNotMatch(recorder.render(), /service="ssh"/);

  const failed = await startMetricsServer({
    listen: { host: "127.0.0.1", port: 0 },
    render: () => {
      throw "render failed";
    },
  });
  try {
    const response = await fetch(failed.url);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /render failed/);
  } finally {
    await failed.close();
  }

  const ipv6 = await startMetricsServer({
    listen: { host: "::1", port: 0 },
    render: () => "# TYPE kepos_test gauge\nkepos_test 1\n",
  });
  assert.match(ipv6.url, /^http:\/\/\[::1\]:\d+\/metrics$/u);
  await ipv6.close();
});

test("canonical mux service channels feed peer metrics in both directions", async () => {
  const [clientOuter, serverOuter] = framedPair();
  const recorder = createPeerMetricsRecorder({
    peers: [{ label: "phone", publicKey: phoneKey }],
    services: [{ id: "ssh", allow: [phoneKey] }],
  });
  recorder.connectionActivated(context("outer-1"));
  const server = createMuxPeer(serverOuter, {
    accept: async () => new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, Buffer.concat([Buffer.from("reply:"), Buffer.from(chunk)]));
      },
    }),
    authorized: true,
    heartbeat: false,
    metrics: recorder,
    metricsContext: context("outer-1"),
    serviceAuthorized: (serviceId) => serviceId === "ssh",
    serviceKind: () => "tcp",
  });
  const client = createMuxPeer(clientOuter, {
    accept: async () => new Transform(),
    authorized: true,
    heartbeat: false,
    serviceAuthorized: () => true,
    serviceKind: () => "tcp",
  });

  try {
    const stream = await client.open("ssh");
    const response = once(stream, "data");
    stream.write(Buffer.from("hello"));
    const [chunk] = await response as [Buffer];
    assert.equal(chunk.toString(), "reply:hello");
    assert.match(recorder.render(), /service_active_channels\{service="ssh"[^}]+\} 1/);
    assert.match(recorder.render(), /service_bytes_total\{direction="subscriber_to_publisher",service="ssh"[^}]+\} 5/);
    assert.match(recorder.render(), /service_bytes_total\{direction="publisher_to_subscriber",service="ssh"[^}]+\} 11/);
    const closed = once(stream, "close");
    stream.destroy();
    await closed;
    server.closeServiceChannels?.("ssh");
    await waitFor(() => /service_active_channels\{service="ssh"[^}]+\} 0/.test(recorder.render()));
    assert.match(recorder.render(), /service_active_channels\{service="ssh"[^}]+\} 0/);
  } finally {
    client.close();
    server.close();
  }
});

test("generated publisher dashboard still consumes only the shipped Prometheus series", () => {
  const dashboard = JSON.parse(
    execFileSync(
      "jsonnet",
      ["-J", "grafana", "grafana/kepos-publisher-observability.jsonnet"],
      { encoding: "utf8" },
    ),
  ) as { title: string; panels: Array<Record<string, unknown>> };
  assert.equal(dashboard.title, "Kepos Publisher Observability");
  assert.ok(dashboard.panels.length > 0);
  const serialized = JSON.stringify(dashboard);
  for (const name of peerMetricNames) assert.match(serialized, new RegExp(name));
  assert.doesNotMatch(serialized, /victoria|vmselect|deployment|secret/i);
});

class FramedDuplex extends Duplex {
  peer?: FramedDuplex;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const frame = Buffer.from(chunk);
    setImmediate(() => this.peer?.push(frame));
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    setImmediate(() => this.peer?.push(null));
    callback(error);
  }
}

function framedPair(): [FramedDuplex, FramedDuplex] {
  const left = new FramedDuplex();
  const right = new FramedDuplex();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for peer state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
