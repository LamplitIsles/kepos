import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertReleaseGitState,
  parseReleaseTag,
} from "../scripts/release-version.js";

test("maps a release tag to the shared version and artifact contract", () => {
  assert.deepEqual(parseReleaseTag("v1.2.3", "release"), {
    tag: "v1.2.3",
    versionName: "1.2.3",
    androidVersionCode: 1_002_003,
    artifactDirectory: "dist/release/v1.2.3",
    androidArtifactName: "kepos-android-arm64-v1.2.3.apk",
    macosArtifactName: "kepos-macos-arm64-v1.2.3.zip",
    checksumName: "SHA256SUMS",
    checksumSignatureName: "SHA256SUMS.minisig",
    mode: "release",
  });
});

test("isolates rehearsal artifacts from formal release artifacts", () => {
  const release = parseReleaseTag("v0.1.0", "release");
  const rehearsal = parseReleaseTag("v0.1.0", "rehearsal");

  assert.equal(release.androidVersionCode, 1_000);
  assert.equal(rehearsal.artifactDirectory, "dist/release/rehearsal-v0.1.0");
  assert.equal(rehearsal.mode, "rehearsal");
  assert.notEqual(rehearsal.artifactDirectory, release.artifactDirectory);
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
      if (arguments_[0] === "status") return "";
      return "v1.2.3\n";
    },
  });

  assert.deepEqual(calls, [
    ["status", "--porcelain"],
    ["describe", "--tags", "--exact-match", "HEAD"],
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

  assert.deepEqual(calls, [["status", "--porcelain"]]);
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
        arguments_[0] === "status" ? "" : "v1.2.4\n",
    }),
    /exact tag v1\.2\.3/i,
  );
});
