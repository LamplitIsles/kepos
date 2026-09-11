import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquireDesktopSingleton,
  desktopSingletonLockPath,
} from "../apps/desktop/src/singleton.js";

test("desktop singleton follows Windows local application state", () => {
  assert.equal(
    desktopSingletonLockPath(
      "C:\\Users\\test",
      { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      "win32",
    ),
    "C:\\Users\\test\\AppData\\Local\\Kepos\\state\\desktop.runtime.lock",
  );
});

test("desktop singleton uses one machine-local lock independent of subscriber state", async () => {
  const homeDirectory = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-home-"),
  );
  const stateHome = path.join(homeDirectory, "state");
  const environment = { XDG_STATE_HOME: stateHome };
  const expected = path.join(
    stateHome,
    "kepos-neo",
    "desktop.runtime.lock",
  );

  try {
    assert.equal(desktopSingletonLockPath(homeDirectory, environment), expected);
    const first = await acquireDesktopSingleton(homeDirectory, environment);
    await assert.rejects(
      () => acquireDesktopSingleton(homeDirectory, environment),
      /desktop is already running/i,
    );
    await first.release();
    const next = await acquireDesktopSingleton(homeDirectory, environment);
    await next.release();
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
