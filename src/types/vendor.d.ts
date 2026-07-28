interface ImportMeta {
  asset?: (specifier: string, parentURL?: string | URL) => string;
}

declare module "hyperdht" {
  const value: unknown;
  export default value;
}

declare module "protomux" {
  const value: unknown;
  export default value;
}

declare module "compact-encoding" {
  const value: unknown;
  export default value;
}

declare module "hypercore-crypto" {
  const value: {
    randomBytes(size: number): Buffer;
  };
  export default value;
}

declare module "sodium-universal" {
  const value: {
    sodium_memcmp(left: Uint8Array, right: Uint8Array): boolean;
  };
  export default value;
}

declare module "which-runtime" {
  export const isWindows: boolean;
}

declare module "bare-native" {
  import { EventEmitter } from "node:events";

  export class WebView extends EventEmitter {
    loadURL(url: string): this;
    loadHTML(html: string): this;
    inspectable(enabled: boolean): this;
    postMessage(message: string): this;
    openExternal(url: string): this;
    destroy(): this;
  }

  export class Window extends EventEmitter {
    constructor(
      width: number,
      height: number,
      options?: { hidesOnClose?: boolean },
    );
    content(view: WebView): this;
    close(): this;
    hide(): this;
    show(): this;
  }

  export class Tray extends EventEmitter {
    constructor(options: {
      systemImageName: string;
      accessibilityDescription?: string;
    });
    addItem(id: string, title: string, options?: { enabled?: boolean }): this;
    addSeparator(): this;
    updateItem(
      id: string,
      options: { title?: string; enabled?: boolean },
    ): this;
    destroy(): this;
  }
}

declare const Bare: {
  readonly argv: string[];
  exitCode: number;
  exit(code?: number): void;
};
