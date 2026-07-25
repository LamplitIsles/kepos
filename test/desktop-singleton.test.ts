import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquireDesktopSingleton,
  desktopSingletonLockPath,
} from "../apps/desktop/src/singleton.js";

test("desktop singleton uses one machine-local lock independent of subscriber state", async () => {
  const homeDirectory = await mkdtemp(
    path.join(tmpdir(), "kepos-desktop-home-"),
  );
  const expected = path.join(
    homeDirectory,
    ".local",
    "state",
    "kepos-neo",
    "desktop.runtime.lock",
  );

  try {
    assert.equal(desktopSingletonLockPath(homeDirectory), expected);
    const first = await acquireDesktopSingleton(homeDirectory);
    await assert.rejects(
      () => acquireDesktopSingleton(homeDirectory),
      /desktop is already running/i,
    );
    await first.release();
    const next = await acquireDesktopSingleton(homeDirectory);
    await next.release();
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
