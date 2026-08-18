import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertReleaseGitState,
  parseReleaseTag,
  prepareReleaseArtifactDirectory,
  releaseSubprocessEnvironment,
} from "../scripts/release-version.js";

test("maps a release tag to the shared version and artifact contract", () => {
  assert.deepEqual(parseReleaseTag("v1.2.3", "release"), {
    tag: "v1.2.3",
    versionName: "1.2.3",
    androidVersionCode: 1_002_003,
    artifactDirectory: "dist/release/v1.2.3",
    androidArtifactName: "kepos-android-arm64.apk",
    macosArtifactName: "kepos-macos-arm64.zip",
    windowsArtifactName: "kepos-windows-x64.zip",
    checksumName: "SHA256SUMS",
    checksumSignatureName: "SHA256SUMS.minisig",
    mode: "release",
  });
});

test("keeps v0.3.0 metadata tag-derived while asset names stay stable", () => {
  const version = parseReleaseTag("v0.3.0", "release");

  assert.equal(version.versionName, "0.3.0");
  assert.equal(version.androidVersionCode, 3_000);
  assert.equal(version.artifactDirectory, "dist/release/v0.3.0");
  assert.equal(version.androidArtifactName, "kepos-android-arm64.apk");
  assert.equal(version.macosArtifactName, "kepos-macos-arm64.zip");
  assert.equal(version.windowsArtifactName, "kepos-windows-x64.zip");
});

test("isolates rehearsal artifacts from formal release artifacts", () => {
  const release = parseReleaseTag("v0.1.0", "release");
  const rehearsal = parseReleaseTag("v0.1.0", "rehearsal");

  assert.equal(release.androidVersionCode, 1_000);
  assert.equal(rehearsal.artifactDirectory, "dist/release/rehearsal-v0.1.0");
  assert.equal(rehearsal.mode, "rehearsal");
  assert.notEqual(rehearsal.artifactDirectory, release.artifactDirectory);
});

test("reuses an empty artifact directory without overwriting an output", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-release-version-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const directory = path.join(root, "v0.1.0");
  const apk = path.join(directory, "kepos-android-arm64.apk");

  await prepareReleaseArtifactDirectory(directory, [apk]);
  await prepareReleaseArtifactDirectory(directory, [apk]);
  await writeFile(apk, "signed apk");

  await assert.rejects(
    prepareReleaseArtifactDirectory(directory, [apk]),
    /output already exists: kepos-android-arm64\.apk/i,
  );
});

test("accepts the Android versionCode ceiling", () => {
  assert.equal(
    parseReleaseTag("v2100.0.0", "release").androidVersionCode,
    2_100_000_000,
  );
});

for (const tag of [
  "0.1.0",
  "v01.0.0",
  "v1.01.0",
  "v1.0.01",
  "v1.0.0-beta.1",
  "v1.0.0+build",
  "v1.1000.0",
  "v1.0.1000",
  "v0.0.0",
  "v2100.0.1",
  "v9007199254740992.0.0",
  "v1.2.3\n",
]) {
  test(`rejects invalid release tag ${JSON.stringify(tag)}`, () => {
    assert.throws(() => parseReleaseTag(tag, "release"), /release tag/i);
  });
}

test("formal releases require a clean exact-tagged worktree", async () => {
  const calls: string[][] = [];
  await assertReleaseGitState({
    tag: "v1.2.3",
    mode: "release",
    runGit: async (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "status" || arguments_[0] === "submodule") return "";
      if (arguments_[0] === "describe") return "v1.2.3\n";
      if (arguments_[0] === "cat-file") return "tag\n";
      return `${"a".repeat(40)}\n`;
    },
  });

  assert.deepEqual(calls, [
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    ["submodule", "status", "--recursive"],
    [
      "submodule",
      "foreach",
      "--recursive",
      'test "$(git rev-parse HEAD)" = "$sha1" && test -z "$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)"',
    ],
    ["describe", "--tags", "--exact-match", "HEAD"],
    ["cat-file", "-t", "refs/tags/v1.2.3"],
    ["rev-parse", "v1.2.3^{commit}"],
    ["rev-parse", "HEAD"],
  ]);
});

test("rehearsals require a clean worktree without requiring a tag", async () => {
  const calls: string[][] = [];
  await assertReleaseGitState({
    tag: "v1.2.3",
    mode: "rehearsal",
    runGit: async (arguments_) => {
      calls.push(arguments_);
      return "";
    },
  });

  assert.deepEqual(calls, [
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    ["submodule", "status", "--recursive"],
    [
      "submodule",
      "foreach",
      "--recursive",
      'test "$(git rev-parse HEAD)" = "$sha1" && test -z "$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)"',
    ],
  ]);
});

test("release git gate rejects dirty and mismatched states", async () => {
  await assert.rejects(
    assertReleaseGitState({
      tag: "v1.2.3",
      mode: "release",
      runGit: async () => " M package.json\n",
    }),
    /worktree must be clean/i,
  );

  await assert.rejects(
    assertReleaseGitState({
      tag: "v1.2.3",
      mode: "release",
      runGit: async (arguments_) =>
        arguments_[0] === "status" || arguments_[0] === "submodule"
          ? ""
          : "v1.2.4\n",
    }),
    /exact tag v1\.2\.3/i,
  );
});

test("shares a version directory without overwriting an existing target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kepos-release-path-"));
  try {
    const androidArtifact = path.join(directory, "kepos.apk");
    const macosArtifact = path.join(directory, "kepos.zip");
    await writeFile(androidArtifact, "apk");

    await prepareReleaseArtifactDirectory(directory, [macosArtifact]);
    await assert.rejects(
      prepareReleaseArtifactDirectory(directory, [androidArtifact]),
      /already exists/i,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("removes release secrets from subprocesses except an explicit allowance", () => {
  const environment = releaseSubprocessEnvironment(
    {
      PATH: "/usr/bin",
      SAFE_VALUE: "kept",
      KEPOS_ANDROID_KEYSTORE: "/private/android.jks",
      KEPOS_ANDROID_KEY_ALIAS: "kepos-release",
      KEPOS_ANDROID_KEY_PASSWORD: "android-password",
      KEPOS_MINISIGN_SECRET_KEY: "/private/minisign.key",
    },
    ["KEPOS_ANDROID_KEY_PASSWORD"],
  );

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    SAFE_VALUE: "kept",
    KEPOS_ANDROID_KEY_PASSWORD: "android-password",
  });
});
