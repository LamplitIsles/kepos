import assert from "node:assert/strict";
import { test } from "node:test";

import type { DhtNode } from "../src/mux/hyperdht.js";
import {
  startDevice,
  type DeviceRuntimeDependencies,
} from "../src/runtime/device.js";
import type {
  PublisherRuntimePolicy,
  RunningPublisher,
} from "../src/runtime/publisher.js";
import type { RunningSubscriber } from "../src/runtime/subscriber.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

const publisherPolicy: PublisherRuntimePolicy = {
  displayName: "Publisher",
  subscribers: [],
  services: [],
};

function harness(options: {
  publisherStartError?: Error;
  publisherStopError?: Error;
  subscriberStartError?: Error;
  subscriberStopError?: Error;
} = {}): {
  calls: string[];
  dependencies: DeviceRuntimeDependencies;
  dht: DhtNode;
  publisher: RunningPublisher;
  subscriber: RunningSubscriber;
} {
  const calls: string[] = [];
  const dht = {
    stats: {
      punches: { consistent: 0, random: 0, open: 0 },
      relaying: { attempts: 0, successes: 0, aborts: 0 },
    },
    connect: () => {
      throw new Error("unexpected connect");
    },
    createServer: () => {
      throw new Error("unexpected server");
    },
    destroy: async () => {
      calls.push("dht.destroy");
    },
  } as DhtNode;
  const publisher = {
    stop: async () => {
      calls.push("publisher.stop");
      if (options.publisherStopError) throw options.publisherStopError;
    },
  } as RunningPublisher;
  const subscriber = {
    stop: async () => {
      calls.push("subscriber.stop");
      if (options.subscriberStopError) throw options.subscriberStopError;
    },
  } as RunningSubscriber;
  return {
    calls,
    dht,
    publisher,
    subscriber,
    dependencies: {
      createDht: (createOptions) => {
        calls.push(
          `dht.create:${createOptions.bootstrap?.[0]?.host ?? "default"}`,
        );
        return dht;
      },
      startPublisher: async (startOptions) => {
        calls.push(
          startOptions.dht === dht
            ? "publisher.start"
            : "publisher.wrong-dht",
        );
        if (options.publisherStartError) throw options.publisherStartError;
        return publisher;
      },
      startSubscriber: async (startOptions) => {
        calls.push(
          startOptions.dht === dht
            ? "subscriber.start"
            : "subscriber.wrong-dht",
        );
        if (options.subscriberStartError) throw options.subscriberStartError;
        return subscriber;
      },
    },
  };
}

test("device starts requested roles concurrently on one node and stops once in order", async () => {
  const first = harness();
  const publisherGate = deferred();
  const publisherStart = first.dependencies.startPublisher;
  first.dependencies.startPublisher = async (options) => {
    const running = await publisherStart(options);
    await publisherGate.promise;
    return running;
  };

  const starting = startDevice(
    {
      bootstrap: [{ host: "bootstrap.example", port: 49_737 }],
      publisher: { stateDir: "/publisher", policy: publisherPolicy },
      subscriber: { stateDir: "/subscriber", services: [] },
    },
    first.dependencies,
  );
  await Promise.resolve();
  const concurrentStartCalls = [...first.calls];
  publisherGate.resolve();
  const running = await starting;

  assert.deepEqual(concurrentStartCalls, [
    "dht.create:bootstrap.example",
    "publisher.start",
    "subscriber.start",
  ]);
  assert.equal(running.publisher, first.publisher);
  assert.equal(running.subscriber, first.subscriber);
  await Promise.all([running.stop(), running.stop()]);
  await running.stop();
  assert.deepEqual(first.calls, [
    ...concurrentStartCalls,
    "publisher.stop",
    "subscriber.stop",
    "dht.destroy",
  ]);
});

test("device startup waits for all roles and cleans a partial start", async () => {
  const failure = new Error("subscriber start failed");
  const first = harness({ subscriberStartError: failure });

  await assert.rejects(
    startDevice(
      {
        publisher: { stateDir: "/publisher", policy: publisherPolicy },
        subscriber: { stateDir: "/subscriber", services: [] },
      },
      first.dependencies,
    ),
    failure,
  );
  assert.deepEqual(first.calls, [
    "dht.create:default",
    "publisher.start",
    "subscriber.start",
    "publisher.stop",
    "dht.destroy",
  ]);
});

test("device startup preserves its failure after cleanup errors", async () => {
  const startFailure = new Error("subscriber start failed");
  const first = harness({
    publisherStopError: new Error("publisher stop failed"),
    subscriberStartError: startFailure,
  });

  await assert.rejects(
    startDevice(
      {
        publisher: { stateDir: "/publisher", policy: publisherPolicy },
        subscriber: { stateDir: "/subscriber", services: [] },
      },
      first.dependencies,
    ),
    startFailure,
  );
  assert.deepEqual(first.calls, [
    "dht.create:default",
    "publisher.start",
    "subscriber.start",
    "publisher.stop",
    "dht.destroy",
  ]);
});

test("device stop attempts every resource and reports the first failure", async () => {
  const publisherFailure = new Error("publisher stop failed");
  const first = harness({
    publisherStopError: publisherFailure,
    subscriberStopError: new Error("subscriber stop failed"),
  });
  const running = await startDevice(
    {
      publisher: { stateDir: "/publisher", policy: publisherPolicy },
      subscriber: { stateDir: "/subscriber", services: [] },
    },
    first.dependencies,
  );

  await assert.rejects(running.stop(), publisherFailure);
  await assert.rejects(running.stop(), publisherFailure);
  assert.deepEqual(first.calls, [
    "dht.create:default",
    "publisher.start",
    "subscriber.start",
    "publisher.stop",
    "subscriber.stop",
    "dht.destroy",
  ]);
});

test("device requires at least one role before creating a node", async () => {
  const first = harness();

  await assert.rejects(
    startDevice({}, first.dependencies),
    /device requires at least one role/,
  );
  assert.deepEqual(first.calls, []);
});
