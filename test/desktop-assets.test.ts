import assert from "node:assert/strict";
import { test } from "node:test";

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

test("desktop UI renders subscriber and local publisher as separate roles", () => {
  const html = renderDesktopUi();

  assert.match(html, /data-role="role-nav"/);
  assert.match(html, /data-role-tab="subscriber"/);
  assert.match(html, /data-role-tab="publisher"/);
  assert.match(html, /const selectRole = \(role\)/);
  assert.match(html, /button\.classList\.toggle\('selected'/);
  assert.match(html, /Shared services/);
  assert.match(html, /Available remotely/);
  assert.doesNotMatch(html, /Shared from this Mac|Share this Mac/);
  assert.match(html, /snapshot\.subscriber/);
  assert.match(html, /snapshot\.publisher/);
  assert.match(html, /publisher\.activeSubscribers/);
  assert.match(html, /publisher\.publisherKey/);
  assert.match(html, /data-action="copy-publisher-key"/);
  assert.match(html, /publisher\.services\.map\(renderPublishedService\)/);
  assert.match(html, /escapeHtml\(service\.name\)/);
  assert.match(html, /escapeHtml\(service\.id\)/);
  assert.doesNotMatch(html, /type:\s*"copyPublisherKey"/);
});

test("desktop publisher UI renders QR invitation and explicit approval states", () => {
  const html = renderDesktopUi();

  assert.match(html, /data-action="create-pairing"/);
  assert.match(html, /class="publisher-primary-actions"/);
  assert.match(html, /class="publisher-meta"/);
  assert.ok(
    html.indexOf('class="publisher-primary-actions"') <
      html.indexOf('class="publisher-meta"'),
    "Add device must stay ahead of optional publisher metadata",
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
