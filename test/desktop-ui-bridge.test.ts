import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { parseDesktopSmokeRenderAcknowledgement } from "../apps/desktop/src/smoke.js";
import { renderDesktopUi } from "../apps/desktop/src/ui.js";

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly classList = {
    toggle: (_className: string, _force?: boolean): void => undefined,
  };
  hidden = false;
  disabled = false;
  innerHTML = "";
  textContent = "";
  value = "";

  addEventListener(
    _type: string,
    _listener: (...arguments_: unknown[]) => unknown,
  ): void {}

  append(..._nodes: FakeElement[]): void {}

  closest(_selector: string): FakeElement {
    return this;
  }

  remove(): void {}

  reportValidity(): void {}

  select(): void {}

  setAttribute(_name: string, _value: string): void {}

  setCustomValidity(_message: string): void {}
}

interface DesktopUiPage {
  messages: string[];
  dispatchHostMessage(message: string): void;
}

function runDesktopUiPage(smokeAcknowledgement: boolean): DesktopUiPage {
  const html = renderDesktopUi({ smokeAcknowledgement });
  const scriptStart = html.indexOf("<script>") + "<script>".length;
  const scriptEnd = html.lastIndexOf("</script>");
  assert.ok(scriptStart > "<script>".length && scriptEnd > scriptStart);

  const messages: string[] = [];
  const listeners = new Map<
    string,
    (event: { data: string }) => void
  >();
  const relationshipButtons = ["remote", "hosted"].map((view) => {
    const button = new FakeElement();
    button.dataset.relationshipTab = view;
    return button;
  });
  const document = {
    addEventListener: (
      _type: string,
      _listener: (...arguments_: unknown[]) => unknown,
    ): void => undefined,
    body: new FakeElement(),
    createElement: (): FakeElement => new FakeElement(),
    execCommand: (_command: string): boolean => true,
    querySelector: (_selector: string): FakeElement => new FakeElement(),
    querySelectorAll: (_selector: string): FakeElement[] => relationshipButtons,
  };
  const window = {
    addEventListener: (
      type: string,
      listener: (event: { data: string }) => void,
    ): void => {
      listeners.set(type, listener);
    },
    bareNative: {
      postMessage: (message: string): void => {
        messages.push(message);
      },
    },
  };

  runInNewContext(html.slice(scriptStart, scriptEnd), {
    document,
    navigator: {},
    window,
  });

  return {
    messages,
    dispatchHostMessage(message): void {
      const listener = listeners.get("bare-native-message");
      assert.ok(listener);
      listener({ data: message });
    },
  };
}

const unconfiguredSnapshot = JSON.stringify({
  type: "snapshot",
  appPhase: "running",
  subscriber: {
    phase: "running",
    connection: "unconfigured",
    subscriberKey: "ab".repeat(32),
    services: [],
  },
});
const renderedAcknowledgement = {
  type: "windows-smoke-rendered",
  connection: "unconfigured",
  serviceCount: 0,
  subscriberKeyPresent: true,
  connectFormVisible: true,
};

test("desktop smoke acknowledgement crosses the page bridge as one JSON object", () => {
  const smokePage = runDesktopUiPage(true);
  const ready = JSON.stringify({ type: "ready" });
  assert.deepEqual(smokePage.messages, [ready]);

  smokePage.dispatchHostMessage(unconfiguredSnapshot);
  assert.deepEqual(smokePage.messages, [
    ready,
    JSON.stringify(renderedAcknowledgement),
  ]);
  assert.deepEqual(
    parseDesktopSmokeRenderAcknowledgement(smokePage.messages[1]!),
    renderedAcknowledgement,
  );

  smokePage.dispatchHostMessage(unconfiguredSnapshot);
  assert.equal(smokePage.messages.length, 2);

  const productionPage = runDesktopUiPage(false);
  productionPage.dispatchHostMessage(unconfiguredSnapshot);
  assert.deepEqual(productionPage.messages, [ready]);
});
