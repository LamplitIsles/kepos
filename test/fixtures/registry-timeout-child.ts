import assert from "node:assert/strict";
import { Duplex } from "node:stream";

import { readHomeRegistryFromConnection } from "../../src/runtime/registry-client.js";

const connection = new Duplex({
  read() {},
  write(_chunk, _encoding, callback) {
    callback();
  },
});

await assert.rejects(
  readHomeRegistryFromConnection(connection, 1),
  /timed out after 1ms/i,
);
await new Promise<void>((resolve) => setImmediate(resolve));
