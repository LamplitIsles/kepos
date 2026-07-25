import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { parseDesktopOptions } from "../apps/desktop/src/options.js";

test("desktop launch options require state and explicit local services", () => {
  assert.deepEqual(
    parseDesktopOptions([
      "--state",
      "~/.local/state/kepos-neo/subscriber",
      "--service",
      "ssh:2222",
      "--service",
      "postgres:15432",
    ]),
    {
      stateDir: path.resolve("~/.local/state/kepos-neo/subscriber"),
      gatewayPort: 17_480,
      services: [
        { id: "ssh", localPort: 2222 },
        { id: "postgres", localPort: 15_432 },
      ],
    },
  );
});

test("desktop launch options reject missing, duplicate, and automatic ports", () => {
  assert.throws(() => parseDesktopOptions([]), /--state/);
  assert.throws(
    () =>
      parseDesktopOptions([
        "--state",
        "state",
        "--service",
        "ssh:0",
      ]),
    /port/,
  );
  assert.throws(
    () =>
      parseDesktopOptions([
        "--state",
        "state",
        "--service",
        "ssh:2222",
        "--service",
        "ssh:2223",
      ]),
    /unique/,
  );
  assert.throws(
    () => parseDesktopOptions(["--state", "state", "--unknown", "x"]),
    /unknown option/,
  );
});
