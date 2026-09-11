import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createServicePresentation,
  createServicePresentations,
} from "../src/services/presentation.js";

test("canonical service presentation preserves actions and endpoint semantics", () => {
  const services = [
    { id: "home", name: "Home", kind: "tcp" as const },
    { id: "forgejo", name: "Forgejo", kind: "tcp" as const },
    { id: "ente", name: "Ente", kind: "tcp" as const },
    { id: "dsh", name: "DSH", kind: "tcp" as const },
    { id: "ssh", name: "SSH", kind: "tcp" as const },
    { id: "unknown", name: "Raw TCP", kind: "tcp" as const },
    { id: "game", name: "Game", kind: "udp" as const },
  ];
  const presentations = createServicePresentations(
    services,
    17_480,
    new Map([
      ["dsh", { kind: "tcp" as const, port: 17_482 }],
      ["ssh", { kind: "tcp" as const, port: 22 }],
      ["unknown", { kind: "tcp" as const, port: 23 }],
      ["game", { kind: "udp" as const, port: 24_642 }],
    ]),
  );

  assert.deepEqual(presentations.map(({ id }) => id), [
    "forgejo",
    "dsh",
    "ssh",
    "unknown",
    "game",
    "ente",
  ]);
  assert.deepEqual(presentations.find(({ id }) => id === "forgejo"), {
    id: "forgejo",
    name: "Forgejo",
    access: "http",
    action: "open",
    icon: "git",
    url: "http://forgejo.localhost:17480/",
  });
  assert.deepEqual(presentations.find(({ id }) => id === "ente"), {
    id: "ente",
    name: "Ente",
    access: "http",
    action: "copy-url",
    icon: "photos",
    url: "http://ente.localhost:17480",
    copyText: "http://ente.localhost:17480",
  });
  assert.deepEqual(presentations.find(({ id }) => id === "dsh"), {
    id: "dsh",
    name: "DSH",
    access: "http",
    action: "open",
    icon: "terminal",
    url: "http://127.0.0.1:17482/",
  });
  assert.deepEqual(presentations.find(({ id }) => id === "ssh"), {
    id: "ssh",
    name: "SSH",
    access: "ssh",
    action: "copy-command",
    icon: "terminal",
    copyText: "ssh -p 22 127.0.0.1",
  });
  assert.deepEqual(presentations.find(({ id }) => id === "unknown"), {
    id: "unknown",
    name: "Raw TCP",
    access: "tcp",
    action: "copy-endpoint",
    icon: "port",
    copyText: "127.0.0.1:23",
  });
  assert.deepEqual(presentations.find(({ id }) => id === "game"), {
    id: "game",
    name: "Game",
    access: "udp",
    action: "copy-endpoint",
    icon: "port",
    copyText: "127.0.0.1:24642",
  });
});

test("canonical presentations never turn raw or unsupported UDP services into HTTP opens", () => {
  const services = [
    { id: "raw", name: "Raw", kind: "tcp" as const },
    { id: "unix", name: "Unix", kind: "tcp" as const },
    { id: "game", name: "Game", kind: "udp" as const },
  ];
  const withoutUdp = createServicePresentations(
    services,
    17_480,
    new Map([["raw", { kind: "tcp" as const }]]),
    { supportsUdp: false },
  );
  assert.deepEqual(withoutUdp.map(({ id }) => id), ["raw", "unix"]);
  assert.deepEqual(
    withoutUdp.find(({ id }) => id === "raw"),
    {
      id: "raw",
      name: "Raw",
      access: "tcp",
      action: "copy-endpoint",
      icon: "port",
    },
  );
  assert.deepEqual(
    createServicePresentations(
      [{ id: "unix", name: "Unix", kind: "tcp" }],
      17_480,
      new Map([["unix", { kind: "tcp", endpoint: "unix:///tmp/kepos.sock" }]]),
    ),
    [{
      id: "unix",
      name: "Unix",
      access: "tcp",
      action: "copy-endpoint",
      icon: "port",
      copyText: "unix:///tmp/kepos.sock",
    }],
  );

  assert.deepEqual(
    createServicePresentations(
      [
        { id: "dagger", name: "Dagger", kind: "tcp" },
        { id: "mihomo", name: "Mihomo", kind: "tcp" },
      ],
      17_480,
      new Map([
        ["dagger", { kind: "tcp", port: 12_000 }],
        ["mihomo", { kind: "tcp", port: 12_001 }],
      ]),
    ),
    [
      {
        id: "dagger",
        name: "Dagger",
        access: "tcp",
        action: "copy-command",
        icon: "dagger",
        copyText: "export _EXPERIMENTAL_DAGGER_RUNNER_HOST=tcp://127.0.0.1:12000",
      },
      {
        id: "mihomo",
        name: "Mihomo",
        access: "tcp",
        action: "copy-url",
        icon: "proxy",
        copyText: "socks5://127.0.0.1:12001",
      },
    ],
  );
  assert.deepEqual(
    createServicePresentation(
      { id: "web", name: "Web", kind: "http" },
      17_480,
    ),
    {
      id: "web",
      name: "Web",
      access: "http",
      action: "open",
      icon: "web",
      url: "http://web.localhost:17480/",
    },
  );
  assert.deepEqual(
    createServicePresentations(
      [{ id: "custom-web", name: "Custom web", kind: "tcp", access: "http" }],
      17_480,
    ),
    [{
      id: "custom-web",
      name: "Custom web",
      access: "http",
      action: "open",
      icon: "web",
      url: "http://custom-web.localhost:17480/",
    }],
  );
});
