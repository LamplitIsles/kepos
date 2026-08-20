import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { renderDesktopUi } from "../apps/desktop/src/ui.js";

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly classList = {
    toggle: (_name: string, _force?: boolean): void => undefined,
    add: (_name: string): void => undefined,
    remove: (_name: string): void => undefined,
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

test("desktop UI keeps Copy diagnostics pending until the bounded result arrives", async () => {
  const html = renderDesktopUi();
  const scriptStart = html.indexOf("<script>") + "<script>".length;
  const scriptEnd = html.lastIndexOf("</script>");
  const messages: string[] = [];
  const elements = new Map<string, FakeElement>();
  const get = (selector: string): FakeElement => {
    let element = elements.get(selector);
    if (!element) {
      element = new FakeElement();
      elements.set(selector, element);
    }
    return element;
  };
  const relationshipButtons = ["remote", "hosted"].map((view) => {
    const button = new FakeElement();
    button.dataset.relationshipTab = view;
    return button;
  });
  let clickListener:
    | ((event: { target: { closest: (_selector: string) => FakeElement } }) => unknown)
    | undefined;
  let messageListener: ((event: { data: string }) => void) | undefined;
  const copied: string[] = [];
  const document = {
    addEventListener: (
      type: string,
      listener: (event: { target: { closest: (_selector: string) => FakeElement } }) => unknown,
    ): void => {
      if (type === "click") clickListener = listener;
    },
    body: new FakeElement(),
    createElement: (): FakeElement => new FakeElement(),
    execCommand: (_command: string): boolean => true,
    querySelector: (selector: string): FakeElement => get(selector),
    querySelectorAll: (_selector: string): FakeElement[] => relationshipButtons,
  };
  const copyButton = get('[data-action="copy-diagnostics"]');
  copyButton.dataset.action = "copy-diagnostics";
  const window = {
    addEventListener: (
      type: string,
      listener: (event: { data: string }) => void,
    ): void => {
      if (type === "bare-native-message") messageListener = listener;
    },
    bareNative: {
      postMessage: (message: string): void => {
        messages.push(message);
      },
    },
  };
  const navigator = {
    clipboard: {
      writeText: async (text: string): Promise<void> => {
        copied.push(text);
      },
    },
  };

  runInNewContext(html.slice(scriptStart, scriptEnd), {
    clearTimeout,
    document,
    navigator,
    setTimeout,
    window,
  });
  assert.deepEqual(messages, [JSON.stringify({ type: "ready" })]);

  await clickListener?.({ target: { closest: () => copyButton } });
  assert.equal(copyButton.disabled, true);
  assert.equal(messages.at(-1), JSON.stringify({ type: "copyDiagnostics" }));

  messageListener?.({
    data: JSON.stringify({
      type: "diagnosticsResult",
      ok: true,
      summary: JSON.stringify({ platform: "win32", droppedEvents: 0, events: [] }),
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(copyButton.disabled, false);
  assert.equal(copied.length, 1);
  assert.match(copied[0] ?? "", /win32/);
});