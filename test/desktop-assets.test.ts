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

test("desktop UI is a self-contained dark Kepos service console", () => {
  const html = renderDesktopUi();

  assert.match(html, /<title>Kepos<\/title>/);
  assert.match(html, /M13 6H5v20h8M19 6h8v20h-8M9 16h14/);
  assert.match(html, /#0d1209/);
  assert.match(html, /#b7ee45/);
  assert.match(html, /data-role="services"/);
  assert.match(html, /data-role="shared-services"/);
  assert.match(html, /data-role="connection"/);
  assert.match(html, /data-role="sharing"/);
  assert.match(html, /data-role="settings"/);
  assert.match(html, /Copy URL/);
  assert.match(html, /Copy command/);
  assert.match(html, /Open/);
  assert.match(html, /bare-native-message/);
  assert.match(html, /postMessage\(JSON\.stringify\(\{ type: "ready" \}\)\)/);
  assert.doesNotMatch(html, /https?:\/\/(?:fonts\.|cdn\.|unpkg\.|jsdelivr\.)/);
  assert.doesNotMatch(html, /prefers-color-scheme:\s*light/);
});

test("desktop UI stays operational instead of repeating product slogans", () => {
  const html = renderDesktopUi();

  assert.doesNotMatch(html, /Far away\. <em>Here\.<\/em>/);
  assert.doesNotMatch(html, /From here\. <em>Shared\.<\/em>/);
  assert.doesNotMatch(html, /LOCAL SURFACE \/ DIRECT/);
  assert.doesNotMatch(html, /One app<br>Independent identities<br>Direct links/);
  assert.doesNotMatch(html, /ONE LINK · MANY LOCAL ADDRESSES/);
  assert.match(html, /data-role="service-count"/);
});

test("desktop rendered-page smoke acknowledgement is opt-in", () => {
  assert.doesNotMatch(renderDesktopUi(), /windows-smoke-rendered/);
  const smokeHtml = renderDesktopUi({ smokeAcknowledgement: true });
  assert.match(smokeHtml, /windows-smoke-rendered/);
  assert.match(smokeHtml, /subscriberKeyPresent/);
  assert.match(smokeHtml, /connectFormVisible/);
});

test("desktop service glyphs use the same Lucide choices as Android", () => {
  const html = renderDesktopUi();

  assert.match(html, /<path d="M2 10v3"\/>/);
  assert.match(html, /<path d="M6 6v11"\/>/);
  assert.match(html, /<path d="M10 3v18"\/>/);
  assert.match(html, /<path d="M14 8v7"\/>/);
  assert.match(html, /<path d="M18 5v13"\/>/);
  assert.match(html, /<path d="M22 10v3"\/>/);
  assert.match(html, /<path d="m7 11 2-2-2-2"\/>/);
  assert.match(html, /<path d="m11 13 4 0"\/>/);
  assert.match(html, /<path d="M12 7v14"\/>/);
  assert.match(html, /<rect x="16" y="16" width="6" height="6" rx="1"\/>/);
  assert.match(html, /<path d="m12 14 4-4"\/>/);
});

test("desktop UI renders remote and hosted relationships at the same time", () => {
  const html = renderDesktopUi();

  assert.match(html, /data-role="relationship-nav"/);
  assert.match(html, /data-relationship-tab="remote"/);
  assert.match(html, /data-relationship-tab="hosted"/);
  assert.match(html, /const selectView = \(view\)/);
  assert.match(html, /button\.classList\.toggle\('selected'/);
  assert.match(html, /Services from this publisher/);
  assert.match(html, /Services published here/);
  assert.doesNotMatch(html, /Shared from this Mac|Share this Mac/);
  assert.match(html, /snapshot\.subscriber/);
  assert.match(html, /snapshot\.publisher/);
  assert.match(html, /publisher\.activeSubscriberKeys/);
  assert.match(html, /publisher\.publisherKey/);
  assert.match(html, /data-action="copy-local-publisher-key"/);
  assert.match(html, /publisher\.services\.map\(renderPublishedService\)/);
  assert.match(html, /escapeHtml\(service\.name\)/);
  assert.match(html, /escapeHtml\(service\.id\)/);
  assert.doesNotMatch(html, /type:\s*"copyPublisherKey"/);
});

test("desktop UI presents publisher-rooted relationships with copyable identities", () => {
  const html = renderDesktopUi();

  assert.match(html, /data-relationship-tab="remote"/);
  assert.match(html, /data-relationship-tab="hosted"/);
  assert.match(html, /Connected to/);
  assert.match(html, /Published here/);
  assert.match(html, /data-role="relationship-publisher"/);
  assert.match(html, /data-role="relationship-subscribers"/);
  assert.match(html, /data-action="copy-remote-publisher-key"/);
  assert.match(html, /data-action="copy-local-subscriber-key"/);
  assert.match(html, /data-action="copy-local-publisher-key"/);
  assert.match(html, /data-action="copy-connected-subscriber"/);
  assert.match(html, /subscriber\.remotePublisher\.publisherKey/);
  assert.match(html, /subscriber\.subscriberKey/);
  assert.match(html, /publisher\.activeSubscriberKeys/);
  assert.match(
    html,
    /publisher\.activeSubscriberKeys\[index\]/,
  );
  assert.match(
    html,
    /const availableServices = services\.filter\(\(service\) => service\.available\)/,
  );
  assert.match(
    html,
    /remoteServiceLabel\.textContent = plural\(availableServices\.length/,
  );
  assert.match(
    html,
    /showingRemote \? availableServices\.length/,
  );
  assert.match(html, /aria-label="Copy remote publisher public key"/);
  assert.match(html, /aria-label="Copy this device subscriber public key"/);
  assert.match(html, /aria-label="Copy this device publisher public key"/);
  assert.match(
    html,
    /aria-label="Copy ' \+ label \+ ' public key"/,
  );

  const remoteRelationship = html.slice(
    html.indexOf('data-role="remote-surface"'),
    html.indexOf('data-role="hosted-surface"'),
  );
  const hostedRelationship = html.slice(
    html.indexOf('data-role="hosted-surface"'),
    html.indexOf('data-role="settings-surface"'),
  );
  assert.ok(
    remoteRelationship.indexOf('data-role="relationship-publisher"') <
      remoteRelationship.indexOf('data-role="relationship-subscribers"'),
    "the remote publisher must be the relationship root",
  );
  assert.ok(
    hostedRelationship.indexOf('data-role="relationship-publisher"') <
      hostedRelationship.indexOf('data-role="relationship-subscribers"'),
    "the local publisher must be the relationship root",
  );
});

test("desktop publisher UI renders QR invitation and explicit approval states", () => {
  const html = renderDesktopUi();

  assert.match(html, /data-action="create-pairing"/);
  assert.match(html, /class="publisher-primary-actions"/);
  assert.ok(
    html.indexOf('class="publisher-primary-actions"') <
      html.indexOf('data-role="pairing"'),
    "Add device must stay ahead of the pairing workflow",
  );
  assert.match(html, /data-role="pairing"/);
  assert.match(html, /pairing\.qrSvg/);
  assert.match(html, /type: "approvePairing"/);
  assert.match(html, /type: "denyPairing"/);
  assert.match(html, /type: "cancelPairing"/);
  assert.doesNotMatch(html, /pairing\.uri[^\n]*textContent/);
});

test("desktop UI derives actions from snapshots without hard-coded endpoints", () => {
  const html = renderDesktopUi();

  assert.match(html, /service\.action === "copy-url"/);
  assert.match(html, /icons\[service\.icon\]/);
  assert.match(html, /service\.copyText/);
  assert.match(html, /service\.url/);
  assert.match(html, /type: "openService", serviceId: service\.id/);
  assert.doesNotMatch(html, /127\.0\.0\.1:17480/);
  assert.doesNotMatch(html, /navidrome\.localhost:17480/);
});

test("desktop hides subscriber addresses but keeps publisher targets", () => {
  const html = renderDesktopUi();
  const subscriberRenderer = html.slice(
    html.indexOf("const renderService ="),
    html.indexOf("const renderPublishedService ="),
  );
  const publisherRenderer = html.slice(
    html.indexOf("const renderPublishedService ="),
    html.indexOf("const selectRole ="),
  );

  assert.doesNotMatch(subscriberRenderer, /service-address/);
  assert.match(publisherRenderer, /service-address/);
  assert.match(publisherRenderer, /127\.0\.0\.1:/);
});

test("desktop bootstrap asset paths are fixed relative to the executable", () => {
  assert.equal(
    desktopBootstrapAssetPath(
      "/Applications/Kepos.app/Contents/MacOS/Kepos",
      "darwin",
    ),
    "/Applications/Kepos.app/Contents/Resources/kepos-bootstrap.json",
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
    await writeFile(assetPath, '{"not":"an endpoint array"}\\n');
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
