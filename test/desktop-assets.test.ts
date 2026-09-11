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
import { renderDesktopUi } from "../apps/desktop/src/ui.js";

test("desktop UI is a self-contained canonical peer service console", () => {
  const html = renderDesktopUi();

  assert.match(html, /<title>Kepos<\/title>/);
  assert.match(html, /data-role="peer-surface"/);
  assert.match(html, /data-role="peer-key"/);
  assert.match(html, /data-role="peer-connections"/);
  assert.match(html, /data-role="peer-services"/);
  assert.match(html, /data-role="peer-bindings"/);
  assert.match(html, /data-role="peer-pairing"/);
  assert.match(html, /data-action="copy-peer-key"/);
  assert.match(html, /type: 'ready'/);
  assert.doesNotMatch(html, /https?:\/\/(?:fonts\.|cdn\.|unpkg\.|jsdelivr\.)/);
  assert.doesNotMatch(html, /snapshot\.(?:publisher|subscriber)/);
  assert.doesNotMatch(html, /(?:publisher|subscriber)Key/);
});

test("desktop UI stays operational instead of repeating product slogans", () => {
  const html = renderDesktopUi();

  assert.doesNotMatch(html, /Far away\. <em>Here\.<\/em>/);
  assert.doesNotMatch(html, /From here\. <em>Shared\.<\/em>/);
  assert.doesNotMatch(html, /LOCAL SURFACE \/ DIRECT/);
  assert.doesNotMatch(html, /One app<br>Independent identities<br>Direct links/);
  assert.match(html, /data-role="service-count"/);
  assert.match(html, /Kepos peer network/);
});

test("desktop rendered-page smoke acknowledgement is opt-in", () => {
  assert.doesNotMatch(renderDesktopUi(), /windows-smoke-rendered/);
  const smokeHtml = renderDesktopUi({ smokeAcknowledgement: true });
  assert.match(smokeHtml, /windows-smoke-rendered/);
  assert.match(smokeHtml, /role: 'peer'/);
  assert.match(smokeHtml, /peerKeyPresent/);
  assert.match(smokeHtml, /connectFormVisible: false/);
  assert.doesNotMatch(smokeHtml, /subscriberKeyPresent/);
});

test("desktop UI derives actions from canonical snapshots without hard-coded endpoints", () => {
  const html = renderDesktopUi();

  assert.match(html, /peer\.services\.map/);
  assert.match(html, /peer\.bindings\.map/);
  assert.match(html, /type: 'openService', serviceId: target\.dataset\.service/);
  assert.match(html, /service\.available/);
  assert.doesNotMatch(html, /127\.0\.0\.1:17480/);
  assert.doesNotMatch(html, /navidrome\.localhost:17480/);
});

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
