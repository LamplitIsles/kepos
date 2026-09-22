import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { parseHTML } from "linkedom";

import { parseDesktopSmokeRenderAcknowledgement } from "../apps/desktop/src/smoke.js";
import { renderDesktopUi } from "../apps/desktop/src/ui.js";
import type { DesktopSnapshot } from "../apps/desktop/src/protocol.js";

function runDesktopUiPage(smokeAcknowledgement = false, savedDevice?: string) {
  const html = renderDesktopUi({ smokeAcknowledgement, localDeviceName: "mac" });
  const { document, window: domWindow } = parseHTML(html);
  const messages: string[] = [];
  const copied: string[] = [];
  const storage = new Map(savedDevice ? [["kepos.selected-device", savedDevice]] : []);
  const listeners = new Map<string, (event: { data: string }) => void>();
  const window = {
    addEventListener: (type: string, listener: (event: { data: string }) => void) => listeners.set(type, listener),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    bareNative: { postMessage: (message: string) => messages.push(message) },
  };
  const script = document.querySelector("script");
  assert.ok(script);
  runInNewContext(script.textContent!, {
    document,
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    window,
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  return {
    messages, copied, storage,
    dispatchHostMessage(message: string) {
      const listener = listeners.get("bare-native-message");
      assert.ok(listener);
      listener({ data: message });
    },
    click(selector: string) {
      const element = document.querySelector(selector);
      assert.ok(element, `missing interactive element: ${selector}`);
      element.dispatchEvent(new domWindow.Event("click", { bubbles: true }));
    },
    search(value: string) {
      const input = document.querySelector<HTMLInputElement>('[aria-label="Filter services"]')!;
      input.value = value;
      input.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    },
    text(selector: string) { return document.querySelector(selector)?.textContent; },
    query(selector: string) { return document.querySelector(selector); },
  };
}

const localKey = "ab".repeat(32);
const remoteKey = "cd".repeat(32);
const canonicalSnapshot: DesktopSnapshot = {
  type: "snapshot",
  appPhase: "running",
  peer: {
    phase: "running", peerKey: localKey, connections: [], services: [], bindings: [],
  },
};
const renderedAcknowledgement = {
  type: "windows-smoke-rendered", role: "peer", connection: "connecting",
  serviceCount: 0, peerKeyPresent: true, connectFormVisible: false,
};

function deviceSnapshot(): DesktopSnapshot {
  return {
    ...canonicalSnapshot,
    peer: {
      ...canonicalSnapshot.peer!,
      connections: [{ label: "kosmos", publicKey: remoteKey, connection: "dial", status: "connected", generation: 1, services: 2 }],
      services: [
        { id: "cua", name: "CUA driver", kind: "tcp", source: { unixSocket: "/fixture/cua.sock" }, available: true },
        { id: "repub", name: "Republished service", kind: "tcp", source: { peer: "kosmos", service: "ssh" }, available: true },
        { id: "dsh", name: "DeepSeek Harness", kind: "tcp", peer: "kosmos", source: { peer: "kosmos", service: "dsh" }, available: true, action: "open", url: "http://dsh.localhost:17480/" },
        { id: "ssh", name: "SSH", kind: "tcp", peer: "kosmos", source: { peer: "kosmos", service: "ssh" }, available: true, action: "copy-command", copyText: "ssh -p 2222 localhost" },
      ],
    },
  };
}

test("desktop smoke acknowledgement crosses the page bridge as one JSON object", () => {
  const smokePage = runDesktopUiPage(true);
  const ready = JSON.stringify({ type: "ready" });
  assert.deepEqual(smokePage.messages, [ready]);
  smokePage.dispatchHostMessage(JSON.stringify({
    type: "snapshot", appPhase: "starting",
    peer: { phase: "starting", connections: [], services: [], bindings: [] },
  }));
  assert.deepEqual(smokePage.messages, [ready]);
  smokePage.dispatchHostMessage(JSON.stringify(canonicalSnapshot));
  assert.deepEqual(smokePage.messages, [ready, JSON.stringify(renderedAcknowledgement)]);
  assert.deepEqual(parseDesktopSmokeRenderAcknowledgement(smokePage.messages[1]!), renderedAcknowledgement);
  smokePage.dispatchHostMessage(JSON.stringify(canonicalSnapshot));
  assert.equal(smokePage.messages.length, 2);
  const productionPage = runDesktopUiPage();
  productionPage.dispatchHostMessage(JSON.stringify(canonicalSnapshot));
  assert.deepEqual(productionPage.messages, [ready]);
});

test("device navigation separates provided services from consumed and republished services", () => {
  const page = runDesktopUiPage();
  page.dispatchHostMessage(JSON.stringify(deviceSnapshot()));
  assert.equal(page.text("h1"), "kosmos");
  assert.match(page.text('[data-role="services"]')!, /DeepSeek Harness/);
  assert.doesNotMatch(page.text('[data-role="services"]')!, /CUA driver|Republished service/);
  page.click(`[data-device="${localKey}"]`);
  assert.equal(page.text("h1"), "mac");
  assert.match(page.text('[data-role="services"]')!, /CUA driver/);
  assert.match(page.text('[data-role="services"]')!, /Republished service/);
  assert.doesNotMatch(page.text('[data-role="services"]')!, /DeepSeek Harness/);
  assert.equal(page.storage.get("kepos.selected-device"), localKey);
  page.dispatchHostMessage(JSON.stringify(deviceSnapshot()));
  assert.equal(page.text("h1"), "mac");
  const restored = runDesktopUiPage(false, localKey);
  restored.dispatchHostMessage(JSON.stringify(deviceSnapshot()));
  assert.equal(restored.text("h1"), "mac");
});

test("search and service actions use the selected device's current availability", async () => {
  const page = runDesktopUiPage();
  const snapshot = deviceSnapshot();
  page.dispatchHostMessage(JSON.stringify(snapshot));
  page.click('[aria-label="Open DeepSeek Harness"]');
  assert.deepEqual(JSON.parse(page.messages.at(-1)!), { type: "openService", serviceId: "dsh" });
  page.search("ssh");
  assert.doesNotMatch(page.text('[data-role="services"]')!, /DeepSeek Harness/);
  page.click('[aria-label="Copy SSH command"]');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(page.copied, ["ssh -p 2222 localhost"]);
  assert.equal(page.text('[role="status"][aria-live="polite"]'), "Command copied");
  snapshot.peer!.connections[0]!.status = "offline";
  snapshot.peer!.services.find(({ id }) => id === "ssh")!.available = false;
  snapshot.peer!.services.find(({ id }) => id === "ssh")!.error = "Peer is offline";
  page.dispatchHostMessage(JSON.stringify(snapshot));
  assert.ok(page.query('[aria-label="Copy SSH command"]')!.hasAttribute("disabled"));
  page.click('[aria-label="Copy SSH command"]');
  assert.equal(page.copied.length, 1);
  assert.match(page.text('[data-role="services"]')!, /Peer is offline/);
});

test("unavailable bindings remain visible before a remote catalog arrives", () => {
  const page = runDesktopUiPage();
  const snapshot = deviceSnapshot();
  snapshot.peer!.services = [];
  snapshot.peer!.connections[0]!.status = "offline";
  snapshot.peer!.bindings = [{ peer: "kosmos", service: "ssh", port: 2222, listen: { localPort: 2222 }, available: false, error: "Peer is offline" }];
  page.dispatchHostMessage(JSON.stringify(snapshot));
  assert.match(page.text('[data-role="services"]')!, /ssh.*127\.0\.0\.1:2222.*Peer is offline/s);
});

test("pairing and diagnostics retain native commands and clipboard feedback", async () => {
  const page = runDesktopUiPage();
  const snapshot = deviceSnapshot();
  page.dispatchHostMessage(JSON.stringify(snapshot));
  page.click('[data-action="invite"]');
  assert.deepEqual(JSON.parse(page.messages.at(-1)!), { type: "createPairingInvitation" });
  snapshot.peer!.pairing = { phase: "pending", label: "phone <script>", platform: "android", peerKey: "ef".repeat(32), keyFingerprint: "efef-efef" };
  page.dispatchHostMessage(JSON.stringify(snapshot));
  assert.match(page.text('[data-role="pairing"]')!, /phone <script>/);
  assert.equal(page.query('[data-role="pairing"] script'), null);
  assert.match(page.text('[data-role="pairing"]')!, /Service access is granted separately/);
  page.click('[data-action="approve"]');
  assert.deepEqual(JSON.parse(page.messages.at(-1)!), { type: "approvePairing" });
  page.click('[data-action="settings"]');
  page.click('[data-action="copy-diagnostics"]');
  assert.deepEqual(JSON.parse(page.messages.at(-1)!), { type: "copyDiagnostics" });
  page.dispatchHostMessage(JSON.stringify({ type: "diagnosticsResult", ok: true, summary: "Test-owned diagnostics" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(page.copied, ["Test-owned diagnostics"]);
});


test("startup snapshots preserve saved devices until the identified catalog arrives", () => {
  const running = deviceSnapshot();
  const firstKey = "ef".repeat(32);
  running.peer!.connections.unshift({ ...running.peer!.connections[0]!, label: "peer-one", publicKey: firstKey });
  const starting: DesktopSnapshot = {
    type: "snapshot", appPhase: "starting",
    peer: { phase: "starting", connections: [], services: [], bindings: [] },
  };
  for (const [saved, expected] of [[remoteKey, "kosmos"], [localKey, "mac"], ["removed", "peer-one"]]) {
    const page = runDesktopUiPage(false, saved);
    page.dispatchHostMessage(JSON.stringify(starting));
    assert.equal(page.storage.get("kepos.selected-device"), saved);
    page.dispatchHostMessage(JSON.stringify(running));
    assert.equal(page.text("h1"), expected);
    assert.equal(page.storage.get("kepos.selected-device"), saved === "removed" ? firstKey : saved);
  }
});
