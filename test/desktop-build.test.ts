import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { desktopAppBundle, desktopBuildCommands } from "../scripts/build-desktop.js";

const repository = process.cwd();

test("desktop build targets an unsigned Apple Silicon Bare app", () => {
  assert.equal(
    desktopAppBundle(repository),
    path.join(repository, "dist", "desktop", "Kepos.app"),
  );
  assert.deepEqual(desktopBuildCommands(repository), [
    {
      command: "tsc",
      arguments: ["-p", "tsconfig.desktop.json"],
    },
    {
      command: "bare-make",
      arguments: [
        "generate",
        "--source",
        path.join(repository, "vendor", "holepunch", "bare-web-kit"),
        "--build",
        path.join(repository, "vendor", "holepunch", "bare-web-kit", "build"),
        "--platform",
        "darwin",
        "--arch",
        "arm64",
        "--define",
        `CMAKE_PREFIX_PATH:PATH=${path.join(repository, "node_modules")}`,
      ],
    },
    {
      command: "bare-make",
      arguments: [
        "build",
        "--build",
        path.join(repository, "vendor", "holepunch", "bare-web-kit", "build"),
      ],
    },
    {
      command: "bare-make",
      arguments: [
        "install",
        "--build",
        path.join(repository, "vendor", "holepunch", "bare-web-kit", "build"),
        "--prefix",
        path.join(
          repository,
          "vendor",
          "holepunch",
          "bare-web-kit",
          "prebuilds",
        ),
      ],
    },
    {
      command: "bare-build",
      arguments: [
        "--base",
        repository,
        "--host",
        "darwin-arm64",
        "--out",
        path.join(repository, "dist", "desktop"),
        "--runtime",
        "bare-native/runtime",
        "--identifier",
        "io.github.ttalab.kepos",
        "--icon",
        path.join(repository, "apps", "desktop", "assets", "Kepos.icns"),
        "--name",
        "Kepos",
        path.join(
          repository,
          ".build",
          "desktop",
          "apps",
          "desktop",
          "src",
          "main.js",
        ),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        path.join(
          repository,
          "dist",
          "desktop",
          "Kepos.app",
          "Contents",
          "Frameworks",
        ),
        path.join(repository, "node_modules", "bare-process"),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        path.join(
          repository,
          "dist",
          "desktop",
          "Kepos.app",
          "Contents",
          "Frameworks",
        ),
        path.join(repository, "node_modules", "bare-app-kit"),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        path.join(
          repository,
          "dist",
          "desktop",
          "Kepos.app",
          "Contents",
          "Frameworks",
        ),
        path.join(repository, "vendor", "holepunch", "bare-web-kit"),
      ],
    },
  ]);
});

test("desktop output is ignored without ignoring desktop source", async () => {
  const gitignore = await readFile(path.join(repository, ".gitignore"), "utf8");

  assert.match(gitignore, /^dist\/desktop\/$/m);
  assert.doesNotMatch(gitignore, /^apps\/desktop\/$/m);
});

test("desktop maps every added Node dependency to Bare", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    imports?: Record<string, { bare?: string; default?: string }>;
  };

  for (const [nodeModule, bareModule] of [
    ["node:crypto", "bare-crypto"],
    ["node:events", "bare-events"],
    ["node:os", "bare-os"],
    ["node:url", "bare-url"],
  ]) {
    assert.deepEqual(packageJson.imports?.[nodeModule], {
      bare: bareModule,
      default: nodeModule,
    });
    assert.equal(typeof packageJson.dependencies?.[bareModule], "string");
  }
});

test("desktop publisher requires no Home static assets", async () => {
  const source = await readFile(
    path.join(repository, "src", "home", "server.ts"),
    "utf8",
  );
  const build = await readFile(
    path.join(repository, "scripts", "build-desktop.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /import\.meta\.asset|home\/index|home\/styles/);
  assert.doesNotMatch(build, /copyDesktopAssets|\.build["'], ["']desktop["'], ["']home/);
  assert.match(
    build,
    /rm\(path\.join\(repository, "\.build", "desktop"\)/,
  );
});
