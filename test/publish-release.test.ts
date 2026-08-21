import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parseRemoteAnnotatedTag,
  publishRelease,
} from "../scripts/publish-release.js";

async function fixture(tag = "v1.2.3"): Promise<{
  repository: string;
  directory: string;
  assets: string[];
  cleanup(): Promise<void>;
}> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "kepos-publish-test-"));
  const directory = path.join(repository, `dist/release/${tag}`);
  await mkdir(path.join(repository, "release"), { recursive: true });
  await mkdir(directory, { recursive: true });
  const apkName = "kepos-android-arm64.apk";
  const zipName = "kepos-macos-arm64.zip";
  const windowsZipName = "kepos-windows-x64.zip";
  await writeFile(path.join(directory, apkName), "apk");
  await writeFile(path.join(directory, zipName), "zip");
  await writeFile(path.join(directory, windowsZipName), "windows zip");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  await writeFile(
    path.join(directory, "SHA256SUMS"),
    `${hash("apk")}  ${apkName}\n${hash("zip")}  ${zipName}\n${hash("windows zip")}  ${windowsZipName}\n`,
  );
  await writeFile(path.join(directory, "SHA256SUMS.minisig"), "signature");
  await writeFile(path.join(repository, "release/minisign.pub"), "public key");
  return {
    repository,
    directory,
    assets: [
      path.join(directory, apkName),
      path.join(directory, zipName),
      path.join(directory, windowsZipName),
      path.join(directory, "SHA256SUMS"),
      path.join(directory, "SHA256SUMS.minisig"),
    ],
    cleanup: () => rm(repository, { force: true, recursive: true }),
  };
}

test("resolves only the dereferenced commit of an annotated remote tag", () => {
  const commit = "a".repeat(40);
  const tagObject = "b".repeat(40);
  assert.equal(
    parseRemoteAnnotatedTag(
      `${tagObject}\trefs/tags/v1.2.3\n${commit}\trefs/tags/v1.2.3^{}\n`,
      "v1.2.3",
    ),
    commit,
  );
  assert.throws(
    () => parseRemoteAnnotatedTag(`${commit}\trefs/tags/v1.2.3\n`, "v1.2.3"),
    /annotated tag/i,
  );
});

test("verifies five fixed assets and creates only a GitHub draft", async () => {
  const files = await fixture();
  const head = "a".repeat(40);
  const commands: Array<{ command: string; arguments: string[] }> = [];
  try {
    await publishRelease(
      { repository: files.repository, tag: "v1.2.3", mode: "release" },
      {
        run: async (command) => {
          commands.push(command);
          if (command.command === "git" && command.arguments[0] === "rev-parse") {
            return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
          }
          if (command.command === "git") {
            return {
              exitCode: 0,
              stdout:
                `${"b".repeat(40)}\trefs/tags/v1.2.3\n` +
                `${head}\trefs/tags/v1.2.3^{}\n`,
              stderr: "",
            };
          }
          if (command.command === "gh" && command.arguments[1] === "view") {
            if (command.arguments.some((argument) => argument.includes("isPrerelease"))) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  tagName: "v1.2.3",
                  isDraft: true,
                  isPrerelease: false,
                }),
                stderr: "",
              };
            }
            return { exitCode: 1, stdout: "", stderr: "release not found" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    const create = commands.find(
      ({ command, arguments: commandArguments }) =>
        command === "gh" && commandArguments[1] === "create",
    );
    assert.deepEqual(create, {
      command: "gh",
      arguments: [
        "release",
        "create",
        "v1.2.3",
        "--draft",
        "--verify-tag",
        "--generate-notes",
        ...files.assets,
      ],
      allowFailure: false,
    });
    assert.doesNotMatch(JSON.stringify(create), /\*|--clobber|--prerelease/);
  } finally {
    await files.cleanup();
  }
});

test("creates beta drafts as prereleases and verifies the GitHub state", async () => {
  const files = await fixture("v0.3.0-beta.1");
  const head = "a".repeat(40);
  const commands: Array<{ command: string; arguments: string[] }> = [];
  try {
    await publishRelease(
      { repository: files.repository, tag: "v0.3.0-beta.1", mode: "release" },
      {
        run: async (command) => {
          commands.push(command);
          if (command.command === "git" && command.arguments[0] === "rev-parse") {
            return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
          }
          if (command.command === "git") {
            return {
              exitCode: 0,
              stdout:
                `${"b".repeat(40)}\trefs/tags/v0.3.0-beta.1\n` +
                `${head}\trefs/tags/v0.3.0-beta.1^{}\n`,
              stderr: "",
            };
          }
          if (command.command === "gh" && command.arguments[1] === "view") {
            if (command.arguments.some((argument) => argument.includes("isPrerelease"))) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  tagName: "v0.3.0-beta.1",
                  isDraft: true,
                  isPrerelease: true,
                }),
                stderr: "",
              };
            }
            return { exitCode: 1, stdout: "", stderr: "release not found" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    const create = commands.find(
      ({ command, arguments: commandArguments }) =>
        command === "gh" && commandArguments[1] === "create",
    );
    assert.ok(create);
    assert.equal(create.arguments.includes("--prerelease"), true);
    const inspection = commands.find(
      ({ command, arguments: commandArguments }) =>
        command === "gh" &&
        commandArguments[1] === "view" &&
        commandArguments.some((argument) => argument.includes("isPrerelease")),
    );
    assert.ok(inspection);
  } finally {
    await files.cleanup();
  }
});

test("rejects rehearsals, mismatched tags, existing releases, and auth failures", async () => {
  const files = await fixture();
  const head = "a".repeat(40);
  const remote = `${"b".repeat(40)}\trefs/tags/v1.2.3\n${head}\trefs/tags/v1.2.3^{}\n`;
  try {
    await assert.rejects(
      publishRelease(
        { repository: files.repository, tag: "v1.2.3", mode: "rehearsal" },
        { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      ),
      /rehearsal/i,
    );

    await assert.rejects(
      publishRelease(
        { repository: files.repository, tag: "v1.2.3", mode: "release" },
        {
          run: async (command) => {
            if (command.command === "git" && command.arguments[0] === "rev-parse") {
              return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
            }
            return {
              exitCode: 0,
              stdout:
                `${"b".repeat(40)}\trefs/tags/v1.2.3\n` +
                `${"c".repeat(40)}\trefs/tags/v1.2.3^{}\n`,
              stderr: "",
            };
          },
        },
      ),
      /does not resolve to local HEAD/i,
    );

    for (const viewResult of [
      { exitCode: 0, stdout: "{}", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "authentication failed" },
    ]) {
      await assert.rejects(
        publishRelease(
          { repository: files.repository, tag: "v1.2.3", mode: "release" },
          {
            run: async (command) => {
              if (command.command === "git" && command.arguments[0] === "rev-parse") {
                return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
              }
              if (command.command === "git") {
                return { exitCode: 0, stdout: remote, stderr: "" };
              }
              if (command.command === "gh" && command.arguments[1] === "view") {
                return viewResult;
              }
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          },
        ),
        /release already exists|authentication failed/i,
      );
    }
  } finally {
    await files.cleanup();
  }
});
