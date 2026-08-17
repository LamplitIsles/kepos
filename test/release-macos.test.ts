import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createMacosReleasePaths,
  macosReleaseEnvironment,
  macosSigningCommands,
  parseMacosReleaseArguments,
  releaseMacos,
} from "../scripts/release-macos.js";

const repository = "/tmp/kepos-repository";
const unpackDirectory = "/tmp/kepos-unpacked";

test("parses one strict tag and an optional rehearsal flag", () => {
  assert.deepEqual(parseMacosReleaseArguments(["v1.2.3"]), {
    tag: "v1.2.3",
    mode: "release",
  });
  assert.deepEqual(
    parseMacosReleaseArguments(["--rehearsal", "v1.2.3"]),
    { tag: "v1.2.3", mode: "rehearsal" },
  );
  assert.throws(() => parseMacosReleaseArguments([]), /usage/i);
  assert.throws(
    () => parseMacosReleaseArguments(["v1.2.3", "--unknown"]),
    /usage/i,
  );
});

test("isolates the macOS build from user npm configuration", () => {
  assert.deepEqual(
    macosReleaseEnvironment("build", {
      PATH: "/usr/bin",
      NPM_CONFIG_USERCONFIG: "/Users/releaser/.npmrc",
      KEPOS_ANDROID_KEY_PASSWORD: "must-not-leak",
    }),
    {
      PATH: "/usr/bin",
      NPM_CONFIG_USERCONFIG: os.devNull,
    },
  );
});

test("signs frameworks in sorted inner-to-outer order before read-only checks", () => {
  const paths = createMacosReleasePaths({
    repository,
    unpackDirectory,
    tag: "v1.2.3",
    mode: "rehearsal",
  });
  const frameworks = [
    path.join(paths.frameworksDirectory, "z.framework"),
    path.join(paths.frameworksDirectory, "a.framework"),
  ];
  const commands = macosSigningCommands(paths, frameworks);

  assert.deepEqual(commands.map(({ kind }) => kind), [
    "architecture",
    "version-short",
    "version-build",
    "sign-framework",
    "sign-framework",
    "sign-app",
    "verify-app",
    "inspect-signature",
    "inspect-version-short",
    "inspect-version-build",
    "archive",
    "extract",
    "verify-archive",
    "inspect-archive-signature",
    "inspect-archive-version-short",
    "inspect-archive-version-build",
    "inspect-archive-architecture",
  ]);
  assert.equal(commands[3].arguments.at(-1), frameworks[1]);
  assert.equal(commands[4].arguments.at(-1), frameworks[0]);
  assert.deepEqual(commands[5], {
    kind: "sign-app",
    command: "codesign",
    arguments: ["--force", "--sign", "-", "--timestamp=none", paths.app],
  });
  assert.equal(
    commands.slice(6).some(({ arguments: commandArguments }) =>
      commandArguments.includes("--force"),
    ),
    false,
  );
});

test("rejects missing and indirect framework paths", () => {
  const paths = createMacosReleasePaths({
    repository,
    unpackDirectory,
    tag: "v1.2.3",
    mode: "release",
  });

  assert.throws(() => macosSigningCommands(paths, []), /framework/i);
  assert.throws(
    () =>
      macosSigningCommands(paths, [
        path.join(paths.frameworksDirectory, "nested", "bad.framework"),
      ]),
    /direct.*framework/i,
  );
  assert.throws(
    () =>
      macosSigningCommands(paths, [
        path.join(paths.frameworksDirectory, "not-a-framework.dylib"),
      ]),
    /direct.*framework/i,
  );
});

test("builds before enumeration and validates the archive round trip", async () => {
  const events: string[] = [];
  const result = await releaseMacos(
    {
      repository,
      unpackDirectory,
      tag: "v1.2.3",
      mode: "rehearsal",
    },
    {
      run: async (command) => {
        events.push(command.kind);
        if (command.kind.includes("architecture")) return "arm64\n";
        if (command.kind.includes("signature")) return "Signature=adhoc\n";
        if (command.kind.includes("version")) return "1.2.3\n";
        return "";
      },
      listFrameworks: async (directory) => {
        events.push("list-frameworks");
        return [path.join(directory, "bare-app-kit.1.0.0.framework")];
      },
      removeFile: async (file) => {
        events.push(`remove-file:${path.basename(file)}`);
      },
      removeTree: async (directory) => {
        events.push(`remove-tree:${path.basename(directory)}`);
      },
    },
  );

  assert.equal(result.macosZip, path.join(
    repository,
    "dist/release/rehearsal-v1.2.3/kepos-macos-arm64-v1.2.3.zip",
  ));
  assert.deepEqual(events.slice(0, 3), [
    "build",
    "list-frameworks",
    "architecture",
  ]);
  assert.equal(events.at(-1), "remove-tree:kepos-unpacked");
});

test("rejects non-arm64 output and removes partial release files", async () => {
  const removed: string[] = [];

  await assert.rejects(
    releaseMacos(
      {
        repository,
        unpackDirectory,
        tag: "v1.2.3",
        mode: "rehearsal",
      },
      {
        run: async (command) =>
          command.kind === "architecture" ? "x86_64 arm64\n" : "",
        listFrameworks: async (directory) => [
          path.join(directory, "bare-app-kit.1.0.0.framework"),
        ],
        removeFile: async (file) => {
          removed.push(file);
        },
        removeTree: async (directory) => {
          removed.push(directory);
        },
      },
    ),
    /arm64/i,
  );
  assert.deepEqual(removed, [
    path.join(
      repository,
      "dist/release/rehearsal-v1.2.3/kepos-macos-arm64-v1.2.3.zip",
    ),
    unpackDirectory,
  ]);
});
