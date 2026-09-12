import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  desktopBootstrapAssetPath,
  DESKTOP_BOOTSTRAP_ASSET,
} from "../apps/desktop/src/paths.js";
import {
  parseDesktopBootstrapAsset,
  readDesktopBootstrapAsset,
} from "../apps/desktop/src/bootstrap.js";
test("desktop bootstrap asset paths are fixed relative to the executable", () => {
  assert.equal(
    desktopBootstrapAssetPath(
      "/Applications/Kepos.app/Contents/MacOS/Kepos",
      "darwin",
    ),
    `/Applications/Kepos.app/Contents/Resources/${DESKTOP_BOOTSTRAP_ASSET}`,
  );
  assert.equal(
    desktopBootstrapAssetPath(
      "C:\\Program Files\\Kepos\\App\\Kepos.exe",
      "win32",
    ),
    `C:\\Program Files\\Kepos\\App\\${DESKTOP_BOOTSTRAP_ASSET}`,
  );
  assert.throws(
    () => desktopBootstrapAssetPath("/tmp/Kepos", "linux"),
    /unsupported desktop asset platform/,
  );
});

test("ordinary desktop bootstrap ignores missing, malformed, and unreadable packaged assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-desktop-assets-"));
  try {
    const executablePath = path.join(
      root,
      "Kepos.app",
      "Contents",
      "MacOS",
      "Kepos",
    );
    const assetPath = desktopBootstrapAssetPath(executablePath, "darwin");
    assert.equal(await readDesktopBootstrapAsset(assetPath), undefined);

    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, '{"not":"an endpoint array"}\n');
    assert.equal(await readDesktopBootstrapAsset(assetPath), undefined);

    await writeFile(assetPath, '[{"host":"bootstrap.example","port":49737}]\n');
    await chmod(assetPath, 0o000);
    assert.equal(await readDesktopBootstrapAsset(assetPath), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop bootstrap parser preserves the established endpoint-object shape", () => {
  assert.deepEqual(
    parseDesktopBootstrapAsset('[{"host":"bootstrap.example","port":49737}]'),
    [{ host: "bootstrap.example", port: 49_737 }],
  );
  assert.equal(parseDesktopBootstrapAsset("null"), undefined);
  assert.throws(
    () => parseDesktopBootstrapAsset('[{"host":"bootstrap.example","port":49737,"extra":true}]'),
    /invalid desktop bootstrap asset/,
  );
});
