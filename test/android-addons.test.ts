import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Bundle from "bare-bundle";
import { verifyAndroidAddonFiles } from "../scripts/verify-android-addons.js";

test("Android bundle requires every linked native addon to be packaged", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kepos-addon-test-"));
  try {
    const bundle = new Bundle();
    bundle.addons = ["linked:libbare-abort.2.0.13.so", "linked:libbare-fs.4.7.4.so"];
    const bundlePath = path.join(directory, "kepos.bundle");
    await writeFile(bundlePath, bundle.toBuffer());
    await writeFile(path.join(directory, "libbare-fs.4.7.4.so"), "native fixture");
    await assert.rejects(verifyAndroidAddonFiles(bundlePath, directory), /missing.*libbare-abort/u);
    await writeFile(path.join(directory, "libbare-abort.2.0.13.so"), "");
    await assert.rejects(verifyAndroidAddonFiles(bundlePath, directory), /invalid.*libbare-abort/u);
    await writeFile(path.join(directory, "libbare-abort.2.0.13.so"), "native fixture");
    await verifyAndroidAddonFiles(bundlePath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
