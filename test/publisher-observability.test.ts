import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Duplex, Transform } from "node:stream";
import { test } from "node:test";

import {
  parseKeposConfig,
  serializeKeposConfig,
} from "../src/app-config.js";
import {
  parsePublisherConfig,
  serializePublisherConfig,
  type SubscriberDevice,
} from "../src/config.js";
import {
  parseMetricsListenOption,
  parseOptions,
  parseSubscriberDeviceOption,
} from "../src/cli/options.js";
import {
  createPublisherMetricsRecorder,
  type PublisherMetricsContext,
  type PublisherMetricsRecorder,
} from "../src/metrics/publisher.js";
import { startMetricsServer } from "../src/metrics/server.js";
import { createMuxPublisher, createMuxSubscriber } from "../src/mux/transport.js";
import { PublisherPairing, type PairingCandidate } from "../src/pairing/publisher.js";
import { parsePairingInvitation } from "../src/pairing/invitation.js";

const publisherKey = "11".repeat(32);
const subscriberKey = "22".repeat(32);
const secondSubscriberKey = "33".repeat(32);
const devices: SubscriberDevice[] = [
  { label: "phone", publicKey: subscriberKey },
  { label: "tablet", publicKey: secondSubscriberKey },
];

function metricsContext(connectionId: string, subscriber = subscriberKey): PublisherMetricsContext {
  return { subscriberKey: subscriber, connectionId };
}

function renderDashboard(): Record<string, unknown> {
  return JSON.parse(
    execFileSync(
      "jsonnet",
      ["-J", "grafana", "grafana/kepos-publisher-observability.jsonnet"],
      { encoding: "utf8" },
    ),
  ) as Record<string, unknown>;
}

function policy(subscribers = devices) {
  return {
    displayName: "publisher",
    subscribers,
    services: [
      { id: "ssh", name: "SSH", targetPort: 22 },
      {
        id: "private",
        name: "Private",
        targetPort: 23,
        allow: [subscriberKey],
      },
    ],
  };
}

test("publisher state and TOML round-trip labeled devices and reject bare keys", () => {
  const config = { seed: publisherKey, subscribers: devices };
  assert.deepEqual(parsePublisherConfig(JSON.parse(serializePublisherConfig(config))), config);
  assert.throws(
    () => parsePublisherConfig({ seed: publisherKey, allow: [subscriberKey] }),
    /unknown field.*allow/i,
  );
  assert.throws(
    () => parsePublisherConfig({ seed: publisherKey, subscribers: [devices[0], devices[0]] }),
    /duplicate subscriber device/i,
  );

  const toml = serializeKeposConfig({
    publisher: { ...policy() },
  });
  assert.match(toml, /public_key = "2{64}"/);
  assert.deepEqual(parseKeposConfig(toml).publisher?.subscribers, devices);
  assert.throws(
    () => parseKeposConfig(`[publisher]\ndisplay_name = "publisher"\nallow = []\nservices = []`),
    /unknown field: publisher\.allow/i,
  );
});

test("subscriber-device and metrics options are routed with bounded values", () => {
  assert.deepEqual(parseSubscriberDeviceOption(`phone:${subscriberKey}`), devices[0]);
  assert.deepEqual(parseSubscriberDeviceOption(`phone=${subscriberKey}`), devices[0]);
  assert.throws(
    () => parseSubscriberDeviceOption(`:${subscriberKey}`),
    /subscriber-device/i,
  );
  const options = parseOptions(
    ["--metrics-listen", "127.0.0.1:9464", "--subscriber-device", `phone:${subscriberKey}`],
    ["--metrics-listen", "--subscriber-device"],
  );
  assert.deepEqual(parseMetricsListenOption(options), { host: "127.0.0.1", port: 9464 });
  assert.throws(
    () => parseOptions(["--allow", subscriberKey], ["--subscriber-device"]),
    /unknown option.*allow/i,
  );
});

test("pairing persistence includes the validated device label", async () => {
  const now = 1_750_000_000_000;
  const saved: SubscriberDevice[] = [];
  const pairing = new PublisherPairing({
    publisherKey,
    displayName: "publisher",
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    persistSubscriber: async (device) => {
      saved.push(device);
    },
  });
  const invitation = pairing.createInvitation();
  const parsed = parsePairingInvitation(invitation.uri, { now: () => now });
  const candidate: PairingCandidate = {
    subscriberKey,
    request: { token: parsed.token, label: "phone", platform: "android" },
    approve: () => undefined,
    deny: () => undefined,
    fail: () => undefined,
  };
  assert.equal(pairing.receive(candidate), true);
  await pairing.approve();
  assert.deepEqual(saved, [{ publicKey: subscriberKey, label: "phone" }]);
});

test("metrics recorder keeps offline zeros, reset gauges, counters, and policy reconciliation", () => {
  let now = 1_700_000_000_000;
  const recorder = createPublisherMetricsRecorder(policy(), () => now);
  let exposition = recorder.render();
  assert.match(exposition, /kepos_publisher_subscriber_connected\{subscriber_id="2222222222222222",subscriber_label="phone"\} 0/);
  assert.match(exposition, /kepos_publisher_service_authorized\{service="private",subscriber_id="2222222222222222",subscriber_label="phone"\} 1/);
  assert.match(exposition, /service="private",subscriber_id="3333333333333333",subscriber_label="tablet"\} 0/);
  assert.doesNotMatch(exposition, new RegExp(subscriberKey));

  recorder.connectionActivated(metricsContext("outer-1"));
  now += 5_000;
  recorder.serviceChannelOpened(metricsContext("outer-1"), "ssh");
  recorder.serviceBytes(metricsContext("outer-1"), "ssh", "subscriber_to_publisher", 5);
  recorder.serviceBytes(metricsContext("outer-1"), "ssh", "publisher_to_subscriber", 7);
  exposition = recorder.render();
  assert.match(exposition, /subscriber_connected\{[^}]+\} 1/);
  assert.match(exposition, /service_active_channels\{service="ssh"[^}]+\} 1/);
  assert.match(exposition, /subscriber_connection_bytes\{direction="subscriber_to_publisher"[^}]+\} 5/);
  assert.match(exposition, /service_bytes_total\{direction="publisher_to_subscriber",service="ssh"[^}]+\} 7/);

  recorder.connectionActivated(metricsContext("outer-2"));
  exposition = recorder.render();
  assert.match(exposition, /subscriber_connection_bytes\{direction="subscriber_to_publisher"[^}]+\} 0/);
  assert.match(exposition, /subscriber_bytes_total\{direction="subscriber_to_publisher"[^}]+\} 5/);
  recorder.connectionClosed(metricsContext("outer-1"));
  assert.match(recorder.render(), /subscriber_connected\{[^}]+\} 1/);
  recorder.connectionClosed(metricsContext("outer-2"));
  exposition = recorder.render();
  assert.match(exposition, /subscriber_connected\{[^}]+\} 0/);
  assert.match(exposition, /last_connected_timestamp_seconds\{[^}]+\} 1700000005/);

  recorder.applyPolicy({
    ...policy([{ label: "phone", publicKey: subscriberKey }, { label: "laptop", publicKey: publisherKey }]),
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
  });
  exposition = recorder.render();
  assert.doesNotMatch(exposition, /subscriber_label="tablet"/);
  assert.match(exposition, /subscriber_label="laptop"/);
  assert.doesNotMatch(exposition, /service="private"/);
  recorder.connectionActivated(metricsContext("outer-3"));
  recorder.serviceChannelOpened(metricsContext("outer-3"), "ssh");
  recorder.serviceBytes(metricsContext("outer-3"), "ssh", "publisher_to_subscriber", 13);
  recorder.applyPolicy({ ...policy(), services: [] });
  recorder.applyPolicy({ ...policy(), services: [{ id: "ssh", name: "SSH", targetPort: 22 }] });
  assert.match(
    recorder.render(),
    /service_active_channels\{service="ssh"[^}]+\} 0/,
  );
  assert.match(
    recorder.render(),
    /service_bytes_total\{direction="publisher_to_subscriber",service="ssh"[^}]+\} 0/,
  );
});

test("metrics removal and re-addition treats a subscriber as new counter state", () => {
  const recorder = createPublisherMetricsRecorder(policy());
  const context = metricsContext("outer-1");
  recorder.connectionActivated(context);
  recorder.serviceBytes(context, "ssh", "publisher_to_subscriber", 17);
  assert.match(
    recorder.render(),
    /subscriber_bytes_total\{direction="publisher_to_subscriber"[^}]+\} 17/,
  );

  recorder.applyPolicy({ ...policy([devices[1]]), services: policy().services });
  recorder.applyPolicy(policy());
  const exposition = recorder.render();
  assert.match(
    exposition,
    /subscriber_bytes_total\{direction="publisher_to_subscriber"[^}]+subscriber_id="2222222222222222"[^}]*\} 0/,
  );
  assert.match(
    exposition,
    /service_bytes_total\{direction="publisher_to_subscriber",service="ssh"[^}]+subscriber_id="2222222222222222"[^}]*\} 0/,
  );
});

test("metrics preserve draining service traffic across ACL revocation and regrant", () => {
  const recorder = createPublisherMetricsRecorder(policy());
  const context = metricsContext("outer-1");
  recorder.connectionActivated(context);
  recorder.serviceChannelOpened(context, "private");
  recorder.serviceBytes(context, "private", "subscriber_to_publisher", 23);
  assert.match(
    recorder.render(),
    /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+\} 23/,
  );

  recorder.applyPolicy({
    ...policy(),
    services: [
      policy().services[0],
      { id: "private", name: "Private", targetPort: 23, allow: [secondSubscriberKey] },
    ],
  });
  assert.match(
    recorder.render(),
    /service_authorized\{service="private",subscriber_id="2222222222222222"[^}]*\} 0/,
  );
  let exposition = recorder.render();
  assert.match(
    exposition,
    /service_active_channels\{service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 1/,
  );
  assert.match(
    exposition,
    /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 23/,
  );
  recorder.serviceBytes(metricsContext("outer-stale"), "private", "subscriber_to_publisher", 99);
  assert.match(
    recorder.render(),
    /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 23/,
  );
  recorder.serviceBytes(context, "private", "subscriber_to_publisher", 11);
  exposition = recorder.render();
  assert.match(
    exposition,
    /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 34/,
  );
  recorder.serviceChannelOpened(context, "private");
  assert.match(
    recorder.render(),
    /service_active_channels\{service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 1/,
  );
  recorder.serviceChannelClosed(context, "private");
  exposition = recorder.render();
  assert.match(
    exposition,
    /service_active_channels\{service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 0/,
  );
  assert.match(
    exposition,
    /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 34/,
  );
  recorder.serviceBytes(context, "private", "subscriber_to_publisher", 7);
  assert.match(
    recorder.render(),
    /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 34/,
  );

  recorder.applyPolicy(policy());
  exposition = recorder.render();
  assert.match(
    exposition,
    /service_authorized\{service="private",subscriber_id="2222222222222222"[^}]*\} 1/,
  );
  assert.match(
    exposition,
    /service_bytes_total\{direction="subscriber_to_publisher",service="private"[^}]+subscriber_id="2222222222222222"[^}]*\} 34/,
  );
});

test("metrics endpoint is read-only and has deterministic lifecycle", async () => {
  const server = await startMetricsServer({
    listen: { host: "127.0.0.1", port: 0 },
    render: () => "# TYPE kepos_test gauge\nkepos_test 1\n",
  });
  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /kepos_test 1/);
  assert.equal((await fetch(`${server.url}/other`)).status, 404);
  assert.equal((await fetch(server.url, { method: "POST" })).status, 405);
  await server.close();
  await server.close();
  await assert.rejects(() => fetch(server.url));
});

test("rendered dashboard keeps functional table contracts and Prometheus-only queries", () => {
  const first = renderDashboard();
  const second = renderDashboard();
  assert.deepEqual(first, second);

  assert.equal(first.title, "Kepos Publisher Observability");
  assert.equal(first.style, "dark");
  const panels = first.panels as Array<Record<string, unknown>>;
  const byTitle = new Map(panels.map((panel) => [panel.title, panel]));
  for (const title of [
    "Online Devices",
    "Active Channels",
    "Current Send Rate",
    "Current Receive Rate",
    "Connected Devices",
    "Authorized Services",
    "Traffic History",
    "Offline Devices",
  ]) {
    assert.ok(byTitle.has(title), `missing dashboard panel: ${title}`);
  }

  const variables = (first.templating as { list: Array<Record<string, unknown>> }).list;
  const datasourceVariable = variables.find(({ name }) => name === "DS_PROMETHEUS");
  assert.deepEqual(datasourceVariable && {
    type: datasourceVariable.type,
    query: datasourceVariable.query,
  }, { type: "datasource", query: "prometheus" });
  assert.ok(variables.some(({ name }) => name === "subscriber_label"));

  for (const [title, direction] of [
    ["Current Send Rate", "publisher_to_subscriber"],
    ["Current Receive Rate", "subscriber_to_publisher"],
  ]) {
    const panel = byTitle.get(title)!;
    assert.equal((panel.fieldConfig as { defaults: { unit: unknown } }).defaults.unit, "Bps");
    const [target] = panel.targets as Array<Record<string, unknown>>;
    assert.match(String(target?.expr), /rate\(.*subscriber_bytes_total/);
    assert.match(String(target?.expr), new RegExp(`direction=\\\"${direction}\\\"`));
  }

  for (const panel of panels) {
    const datasource = panel.datasource as { type?: unknown; uid?: unknown };
    assert.equal(datasource.type, "prometheus");
    assert.equal(datasource.uid, "${DS_PROMETHEUS}");
    assert.doesNotMatch(JSON.stringify(panel), /victoria|vmselect|deployment|secret/i);
    if (panel.type !== "table") continue;
    for (const target of panel.targets as Array<Record<string, unknown>>) {
      assert.equal(target.instant, true, `${String(panel.title)} must be instant`);
      assert.equal(target.range, false, `${String(panel.title)} must not use a range`);
    }
    assert.ok(
      (panel.transformations as Array<Record<string, unknown>>).some(
        ({ id }) => id === "joinByField",
      ),
      `${String(panel.title)} must join current query frames`,
    );
  }

  const connected = byTitle.get("Connected Devices")!;
  const connectedTargets = connected.targets as Array<Record<string, unknown>>;
  assert.equal(connectedTargets.length, 5);
  assert.match(String(connectedTargets[0]?.expr), /connected.*== 1/);
  assert.match(String(connectedTargets[1]?.expr), /connection_bytes/);
  assert.match(String(connectedTargets[1]?.expr), /publisher_to_subscriber/);
  assert.match(String(connectedTargets[1]?.expr), /and on \(subscriber_id, subscriber_label\)/);
  assert.match(String(connectedTargets[2]?.expr), /subscriber_to_publisher/);
  assert.match(String(connectedTargets[2]?.expr), /and on \(subscriber_id, subscriber_label\)/);
  assert.match(String(connectedTargets[3]?.expr), /rate\(.*subscriber_bytes_total/);
  assert.match(String(connectedTargets[3]?.expr), /publisher_to_subscriber/);
  assert.match(String(connectedTargets[3]?.expr), /subscriber_id, subscriber_label/);
  assert.match(String(connectedTargets[4]?.expr), /rate\(.*subscriber_bytes_total/);
  assert.match(String(connectedTargets[4]?.expr), /subscriber_to_publisher/);
  assert.match(String(connectedTargets[4]?.expr), /subscriber_id, subscriber_label/);
  assert.equal(
    ((connected.transformations as Array<Record<string, unknown>>)[0]?.options as Record<string, unknown>).byField,
    "subscriber_id",
  );
  const connectedOrganize = (connected.transformations as Array<Record<string, unknown>>)
    .find(({ id }) => id === "organize")?.options as {
      excludeByName: Record<string, unknown>;
      renameByName: Record<string, unknown>;
    };
  assert.equal(connectedOrganize.renameByName["Value #A"], "Status");
  assert.equal(connectedOrganize.renameByName["Value #B"], "Send bytes");
  assert.equal(connectedOrganize.renameByName["Value #C"], "Receive bytes");
  assert.equal(connectedOrganize.renameByName["Value #D"], "Send rate");
  assert.equal(connectedOrganize.renameByName["Value #E"], "Receive rate");
  assert.equal(connectedOrganize.excludeByName["subscriber_label 5"], true);
  assert.equal((connected.fieldConfig as { defaults: { unit: unknown } }).defaults.unit, "short");
  assert.match(JSON.stringify(connected.fieldConfig), /Send bytes/);
  assert.match(JSON.stringify(connected.fieldConfig), /Receive bytes/);
  assert.match(JSON.stringify(connected.fieldConfig), /Send rate/);
  assert.match(JSON.stringify(connected.fieldConfig), /Receive rate/);
  assert.match(JSON.stringify(connected.fieldConfig), /"id":"unit","value":"bytes"/);
  assert.match(JSON.stringify(connected.fieldConfig), /"id":"unit","value":"Bps"/);
  assert.match(JSON.stringify(connected.fieldConfig), /Online/);
  assert.match(JSON.stringify(connected.fieldConfig), /custom\.cellOptions/);

  const authorized = byTitle.get("Authorized Services")!;
  const authorizedTargets = authorized.targets as Array<Record<string, unknown>>;
  assert.equal(authorizedTargets.length, 4);
  assert.match(String(authorizedTargets[0]?.expr), /service_authorized/);
  assert.match(String(authorizedTargets[0]?.expr), /== 1/);
  assert.doesNotMatch(String(authorizedTargets[1]?.expr), /> 0/);
  assert.match(String(authorizedTargets[1]?.expr), /active_channels/);
  assert.match(String(authorizedTargets[1]?.expr), /and on \(subscriber_id, subscriber_label, service\)/);
  assert.match(String(authorizedTargets[2]?.expr), /rate\(.*service_bytes_total/);
  assert.match(String(authorizedTargets[2]?.expr), /publisher_to_subscriber/);
  assert.match(String(authorizedTargets[2]?.expr), /service/);
  assert.match(String(authorizedTargets[3]?.expr), /rate\(.*service_bytes_total/);
  assert.match(String(authorizedTargets[3]?.expr), /subscriber_to_publisher/);
  assert.match(String(authorizedTargets[3]?.expr), /service/);
  assert.equal(
    ((authorized.transformations as Array<Record<string, unknown>>)[0]?.options as Record<string, unknown>).byField,
    "device_service",
  );
  const authorizedOrganize = (authorized.transformations as Array<Record<string, unknown>>)
    .find(({ id }) => id === "organize")?.options as {
      excludeByName: Record<string, unknown>;
      renameByName: Record<string, unknown>;
    };
  assert.equal(authorizedOrganize.renameByName["service 1"], "Published service");
  assert.equal(authorizedOrganize.renameByName["Value #A"], "Authorization");
  assert.equal(authorizedOrganize.renameByName["Value #B"], "Active channels");
  assert.equal(authorizedOrganize.renameByName["Value #C"], "Send rate");
  assert.equal(authorizedOrganize.renameByName["Value #D"], "Receive rate");
  assert.equal(authorizedOrganize.excludeByName["service 2"], true);
  assert.match(JSON.stringify(authorized.fieldConfig), /Active channels/);
  assert.match(JSON.stringify(authorized.fieldConfig), /Authorization/);
  assert.match(JSON.stringify(authorized.fieldConfig), /Send rate/);
  assert.match(JSON.stringify(authorized.fieldConfig), /Receive rate/);
  assert.match(JSON.stringify(authorized.fieldConfig), /"id":"unit","value":"Bps"/);
  assert.match(JSON.stringify(authorized.fieldConfig), /#f2a65a/);

  const offline = byTitle.get("Offline Devices")!;
  const offlineTargets = offline.targets as Array<Record<string, unknown>>;
  assert.equal(offlineTargets.length, 2);
  assert.match(String(offlineTargets[0]?.expr), /connected.*== 0/);
  assert.match(String(offlineTargets[1]?.expr), /last_connected_timestamp/);
  assert.match(String(offlineTargets[1]?.expr), /\* 1000/);
  assert.match(String(offlineTargets[1]?.expr), /and on \(subscriber_id, subscriber_label\)/);
  assert.equal((offline.fieldConfig as { defaults: { unit: unknown } }).defaults.unit, "short");
  assert.match(JSON.stringify(offline.fieldConfig), /#59636b/);
  assert.match(JSON.stringify(offline.fieldConfig), /dateTimeAsIso/);
  assert.match(JSON.stringify(offline.fieldConfig), /Never/);
  const offlineOrganize = (offline.transformations as Array<Record<string, unknown>>)
    .find(({ id }) => id === "organize")?.options as {
      renameByName: Record<string, unknown>;
    };
  assert.equal(offlineOrganize.renameByName["Value #A"], "Status");
  assert.equal(offlineOrganize.renameByName["Value #B"], "Last connected");

  assert.equal(
    (byTitle.get("Traffic History")!.fieldConfig as { defaults: { unit: unknown } }).defaults.unit,
    "Bps",
  );
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

function prefixedService(): Duplex {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, Buffer.concat([Buffer.from("reply:"), chunk]));
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for metrics");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("mux service payloads feed publisher metrics in both directions", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const recorder: PublisherMetricsRecorder = createPublisherMetricsRecorder({
    displayName: "publisher",
    subscribers: [{ label: "phone", publicKey: subscriberKey }],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
  });
  recorder.connectionActivated(metricsContext("outer-1"));
  const publisher = createMuxPublisher(publisherOuter, {
    outerId: "outer-1",
    subscriberPublicKey: subscriberKey,
    metricsContext: metricsContext("outer-1"),
    metrics: recorder,
    connect: async () => prefixedService(),
  });
  const subscriber = createMuxSubscriber(subscriberOuter);
  const stream = await subscriber.open("ssh");
  const response = once(stream, "data");
  stream.write("hello");
  const [chunk] = (await response) as [Buffer];
  assert.equal(chunk.toString(), "reply:hello");
  await waitFor(() => /subscriber_connection_bytes\{direction="publisher_to_subscriber"[^}]+\} 11/.test(recorder.render()));
  assert.match(recorder.render(), /service_active_channels\{service="ssh"[^}]+\} 1/);
  assert.match(recorder.render(), /service_bytes_total\{direction="subscriber_to_publisher",service="ssh"[^}]+\} 5/);
  const closed = once(stream, "close");
  stream.destroy();
  await closed;
  await waitFor(() => /service_active_channels\{service="ssh"[^}]+\} 0/.test(recorder.render()));
  recorder.connectionClosed(metricsContext("outer-1"));
  assert.match(recorder.render(), /subscriber_connection_bytes\{direction="publisher_to_subscriber"[^}]+\} 0/);
  subscriber.close();
  publisher.close();
});
