import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  androidReleaseEnvironment,
  createAndroidReleasePlan,
  executeAndroidRelease,
  normalizeCertificateFingerprint,
  parseAndroidReleaseArguments,
} from "../scripts/release-android.js";

const repository = "/tmp/kepos-repository";
const androidHome = "/tmp/android-sdk";
const keystore = "/tmp/kepos-secrets/kepos-release.jks";
const password = "not-a-real-password";
const fingerprint = "ab".repeat(32);

test("exposes the Android key password only to the signing process", () => {
  const environment = {
    PATH: "/usr/bin",
    KEPOS_ANDROID_KEYSTORE: keystore,
    KEPOS_ANDROID_KEY_ALIAS: "kepos-release",
    KEPOS_ANDROID_KEY_PASSWORD: password,
  };

  assert.equal(
    androidReleaseEnvironment("build", environment).KEPOS_ANDROID_KEY_PASSWORD,
    undefined,
  );
  assert.equal(
    androidReleaseEnvironment("verify", environment).KEPOS_ANDROID_KEY_PASSWORD,
    undefined,
  );
  assert.equal(
    androidReleaseEnvironment("sign", environment).KEPOS_ANDROID_KEY_PASSWORD,
    password,
  );
  assert.equal(
    androidReleaseEnvironment("sign", environment).KEPOS_ANDROID_KEYSTORE,
    undefined,
  );
  assert.equal(
    androidReleaseEnvironment("sign", environment).KEPOS_ANDROID_KEY_ALIAS,
    undefined,
  );
});

test("parses one strict tag and an optional rehearsal flag", () => {
  assert.deepEqual(parseAndroidReleaseArguments(["v1.2.3"]), {
    tag: "v1.2.3",
    mode: "release",
  });
  assert.deepEqual(
    parseAndroidReleaseArguments(["v1.2.3", "--rehearsal"]),
    { tag: "v1.2.3", mode: "rehearsal" },
  );
  assert.throws(() => parseAndroidReleaseArguments([]), /usage/i);
  assert.throws(
    () => parseAndroidReleaseArguments(["v1.2.3", "--unknown"]),
    /usage/i,
  );
});

test("builds, aligns, signs, and verifies a versioned APK without exposing the password", () => {
  const plan = createAndroidReleasePlan({
    repository,
    androidHome,
    keystore,
    keyAlias: "kepos-release",
    keyPassword: password,
    expectedFingerprint: fingerprint,
    tag: "v1.2.3",
    mode: "rehearsal",
  });

  assert.deepEqual(
    plan.commands.map(({ kind }) => kind),
    ["fetch", "bundle", "build", "zipalign", "sign", "verify"],
  );
  assert.deepEqual(plan.commands[2], {
    kind: "build",
    command: path.join(repository, "android", "gradlew"),
    arguments: [
      "-p",
      "android",
      "assembleDebug",
      "assembleRelease",
      "-PkeposVersionName=1.2.3",
      "-PkeposVersionCode=1002003",
    ],
  });
  assert.deepEqual(plan.commands[3].arguments.slice(0, 5), [
    "-f",
    "-P",
    "16",
    "4",
    path.join(
      repository,
      "android/app/build/outputs/apk/release/app-release-unsigned.apk",
    ),
  ]);
  assert.deepEqual(plan.commands[4].arguments.slice(0, 8), [
    "sign",
    "--ks",
    keystore,
    "--ks-key-alias",
    "kepos-release",
    "--ks-pass",
    "env:KEPOS_ANDROID_KEY_PASSWORD",
    "--key-pass",
  ]);
  assert.deepEqual(
    plan.commands[4].arguments.slice(
      plan.commands[4].arguments.indexOf("--v4-signing-enabled"),
      plan.commands[4].arguments.indexOf("--v4-signing-enabled") + 2,
    ),
    ["--v4-signing-enabled", "false"],
  );
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(password));
  assert.equal(
    plan.finalApk,
    path.join(
      repository,
      "dist/release/rehearsal-v1.2.3/kepos-android-arm64-v1.2.3.apk",
    ),
  );
});

test("rejects missing, in-repository, and malformed signing inputs", () => {
  const valid = {
    repository,
    androidHome,
    keystore,
    keyAlias: "kepos-release",
    keyPassword: password,
    expectedFingerprint: fingerprint,
    tag: "v1.2.3",
    mode: "release" as const,
  };

  assert.throws(
    () => createAndroidReleasePlan({ ...valid, keyPassword: "" }),
    /password/i,
  );
  assert.throws(
    () =>
      createAndroidReleasePlan({
        ...valid,
        keystore: path.join(repository, "release.jks"),
      }),
    /outside the repository/i,
  );
  assert.throws(
    () => createAndroidReleasePlan({ ...valid, expectedFingerprint: "AA:BB" }),
    /fingerprint/i,
  );
});

test("normalizes the apksigner certificate digest", () => {
  assert.equal(
    normalizeCertificateFingerprint(
      `Signer #1 certificate SHA-256 digest: ${"AB:".repeat(31)}AB\n`,
    ),
    fingerprint,
  );
  assert.throws(() => normalizeCertificateFingerprint("Verified\n"), /digest/i);
});

test("removes named output when signer fingerprint verification fails", async () => {
  const plan = createAndroidReleasePlan({
    repository,
    androidHome,
    keystore,
    keyAlias: "kepos-release",
    keyPassword: password,
    expectedFingerprint: fingerprint,
    tag: "v1.2.3",
    mode: "rehearsal",
  });
  const removed: string[] = [];

  await assert.rejects(
    executeAndroidRelease(plan, {
      run: async (command) =>
        command.kind === "verify"
          ? `Signer #1 certificate SHA-256 digest: ${"cd".repeat(32)}\n`
          : "",
      remove: async (file) => {
        removed.push(file);
      },
      reportSizes: async () => "unused",
    }),
    /certificate fingerprint does not match/i,
  );
  assert.deepEqual(removed, [plan.finalApk, plan.alignedApk]);
});

test("reports sizes only after successful signer verification", async () => {
  const plan = createAndroidReleasePlan({
    repository,
    androidHome,
    keystore,
    keyAlias: "kepos-release",
    keyPassword: password,
    expectedFingerprint: fingerprint,
    tag: "v1.2.3",
    mode: "rehearsal",
  });
  const events: string[] = [];

  const report = await executeAndroidRelease(plan, {
    run: async (command) => {
      events.push(command.kind);
      return command.kind === "verify"
        ? `Signer #1 certificate SHA-256 digest: ${fingerprint}\n`
        : "";
    },
    remove: async (file) => {
      events.push(`remove:${path.basename(file)}`);
    },
    reportSizes: async (_repository, releaseApk) => {
      events.push(`report:${path.basename(releaseApk)}`);
      return "size report";
    },
  });

  assert.equal(report, "size report");
  assert.deepEqual(events.slice(0, 6), [
    "fetch",
    "bundle",
    "build",
    "zipalign",
    "sign",
    "verify",
  ]);
  assert.deepEqual(events.slice(6), [
    `report:${path.basename(plan.finalApk)}`,
    `remove:${path.basename(plan.alignedApk)}`,
  ]);
});
