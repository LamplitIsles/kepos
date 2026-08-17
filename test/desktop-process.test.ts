import assert from "node:assert/strict";
import { test } from "node:test";

import { desktopLaunchArguments } from "../apps/desktop/src/process.js";

test("desktop options exclude the packaged app executable", () => {
  assert.deepEqual(
    desktopLaunchArguments([
      "C:\\Program Files\\Kepos\\Kepos.exe",
      "--state",
      "C:\\Temp\\state",
    ]),
    ["--state", "C:\\Temp\\state"],
  );
});
