import assert from "node:assert/strict";
import { test } from "node:test";

import {
  desktopLaunchArguments,
  terminateDesktopBeforeWindow,
} from "../apps/desktop/src/process.js";

test("desktop options exclude the packaged app executable", () => {
  assert.deepEqual(
    desktopLaunchArguments([
      "/Applications/Kepos.app/Contents/MacOS/Kepos",
      "--state",
      "/state/subscriber",
    ]),
    ["--state", "/state/subscriber"],
  );
});

test("desktop fatal startup exits the AppKit runtime before any window exists", () => {
  const calls: Array<[number, string]> = [];

  terminateDesktopBeforeWindow({
    pid: 42,
    kill(pid, signal) {
      calls.push([pid, signal]);
    },
  });

  assert.deepEqual(calls, [[42, "SIGTERM"]]);
});
