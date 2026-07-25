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
