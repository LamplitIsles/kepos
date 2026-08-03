import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createReleaseManifest,
  parseManifestReleaseArguments,
} from "../scripts/release-manifest.js";

async function fixture(): Promise<{
  repository: string;
  directory: string;
  apk: string;
  zip: string;
  cleanup(): Promise<void>;
}> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "kepos-manifest-test-"));
  const directory = path.join(repository, "dist/release/rehearsal-v1.2.3");
  await mkdir(directory, { recursive: true });
  const apk = path.join(directory, "kepos-android-arm64-v1.2.3.apk");
  const zip = path.join(directory, "kepos-macos-arm64-v1.2.3.zip");
  await writeFile(apk, "android artifact");
  await writeFile(zip, "macos artifact");
  return {
    repository,
    directory,
    apk,
    zip,
    cleanup: () => rm(repository, { force: true, recursive: true }),
  };
}

test("parses one strict tag and an optional rehearsal flag", () => {
  assert.deepEqual(parseManifestReleaseArguments(["v1.2.3"]), {
    tag: "v1.2.3",
    mode: "release",
  });
  assert.deepEqual(
    parseManifestReleaseArguments(["v1.2.3", "--rehearsal"]),
    { tag: "v1.2.3", mode: "rehearsal" },
  );
  assert.throws(() => parseManifestReleaseArguments([]), /usage/i);
});

test("writes stable checksums, signs them, and verifies both layers", async () => {
  const files = await fixture();
  const secretKey = path.join(path.dirname(files.repository), "minisign.key");
  const commands: Array<{ command: string; arguments: string[] }> = [];
  try {
    const result = await createReleaseManifest(
      {
        repository: files.repository,
        tag: "v1.2.3",
        mode: "rehearsal",
        secretKey,
      },
      {
        run: async (command) => {
          commands.push(command);
          if (command.arguments[0] === "-S") {
            const signature = command.arguments[command.arguments.indexOf("-x") + 1];
            await writeFile(signature, "minisign signature");
          }
        },
      },
    );

    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    assert.equal(
      await readFile(result.manifest, "utf8"),
      `${digest("android artifact")}  kepos-android-arm64-v1.2.3.apk\n` +
        `${digest("macos artifact")}  kepos-macos-arm64-v1.2.3.zip\n`,
    );
    assert.deepEqual(commands.map(({ arguments: commandArguments }) => commandArguments[0]), [
      "-S",
      "-V",
    ]);
    assert.equal(commands[0].arguments.includes(secretKey), true);
    assert.doesNotMatch(JSON.stringify(commands), /password/i);
  } finally {
    await files.cleanup();
  }
});

test("rejects missing, empty, extra, and symlink artifacts", async () => {
  const secretKey = "/tmp/kepos-secret/minisign.key";

  for (const mutate of [
    async (files: Awaited<ReturnType<typeof fixture>>) => rm(files.apk),
    async (files: Awaited<ReturnType<typeof fixture>>) => writeFile(files.apk, ""),
    async (files: Awaited<ReturnType<typeof fixture>>) =>
      writeFile(path.join(files.directory, "extra.apk"), "extra"),
    async (files: Awaited<ReturnType<typeof fixture>>) => {
      await rm(files.apk);
      await symlink(files.zip, files.apk);
    },
  ]) {
    const files = await fixture();
    try {
      await mutate(files);
      await assert.rejects(
        createReleaseManifest(
          {
            repository: files.repository,
            tag: "v1.2.3",
            mode: "rehearsal",
            secretKey,
          },
          { run: async () => undefined },
        ),
        /artifact/i,
      );
    } finally {
      await files.cleanup();
    }
  }
});

test("rejects a secret key path inside the repository", async () => {
  const files = await fixture();
  try {
    await assert.rejects(
      createReleaseManifest(
        {
          repository: files.repository,
          tag: "v1.2.3",
          mode: "rehearsal",
          secretKey: path.join(files.repository, "minisign.key"),
        },
        { run: async () => undefined },
      ),
      /outside the repository/i,
    );
  } finally {
    await files.cleanup();
  }
});
