import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  pathExists,
  readStateJson,
  replaceFileAtomically,
  validateStateDirectory,
  writeStateDirectoryAtomically,
  writeStateFileAtomically,
} from "../src/state/files.js";

test("state file helpers create private directories and replace files atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-state-files-"));
  const stateDir = path.join(root, "nested", "peer");
  try {
    assert.equal(await pathExists(root), true);
    assert.equal(await pathExists(path.join(root, "missing")), false);

    await writeStateDirectoryAtomically(
      stateDir,
      new Map([["peer.json", '{"seed":"' + "ab".repeat(32) + '"}\n']]),
    );
    await validateStateDirectory(stateDir, ["peer.json"]);
    assert.deepEqual(await readdir(stateDir), ["peer.json"]);

    const replaced = await writeStateFileAtomically(
      stateDir,
      "peer.json",
      '{"seed":"' + "cd".repeat(32) + '"}\n',
    );
    assert.equal(replaced, path.join(stateDir, "peer.json"));
    assert.equal(await readFile(replaced, "utf8"), '{"seed":"' + "cd".repeat(32) + '"}\n');
    assert.deepEqual(await readdir(stateDir), ["peer.json"]);

    if (process.platform !== "win32") {
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal((await stat(replaced)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state file helpers reject invalid state without removing the existing value", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-state-files-invalid-"));
  try {
    const destination = path.join(root, "config.toml");
    const source = path.join(root, "next.toml");
    await writeFile(destination, "previous", { mode: 0o600 });
    await assert.rejects(
      replaceFileAtomically(path.join(root, "missing.toml"), destination),
      { code: "ENOENT" },
    );
    assert.equal(await readFile(destination, "utf8"), "previous");
    await writeFile(source, "next", { mode: 0o600 });
    await replaceFileAtomically(source, destination);
    assert.equal(await readFile(destination, "utf8"), "next");

    const malformed = path.join(root, "malformed.json");
    await writeFile(malformed, "not-json", { mode: 0o600 });
    await assert.rejects(() => readStateJson(malformed), /invalid state file/);

    const partial = path.join(root, "partial");
    await mkdir(partial, { mode: 0o700 });
    await assert.rejects(
      () => validateStateDirectory(partial, ["peer.json"]),
      /partial or invalid state/,
    );

    const extra = path.join(root, "extra");
    await mkdir(extra, { mode: 0o700 });
    await writeFile(path.join(extra, "peer.json"), "{}", { mode: 0o600 });
    await writeFile(path.join(extra, "stale.json"), "{}", { mode: 0o600 });
    await assert.rejects(
      () => validateStateDirectory(extra, ["peer.json"]),
      /partial or invalid state/,
    );

    const notDirectory = path.join(root, "not-directory");
    await writeFile(notDirectory, "file", { mode: 0o600 });
    await assert.rejects(
      () => validateStateDirectory(notDirectory, []),
      /regular directory/,
    );

    const symlinked = path.join(root, "symlinked");
    await mkdir(symlinked, { mode: 0o700 });
    const target = path.join(root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path.join(symlinked, "peer.json"));
    await assert.rejects(
      () => validateStateDirectory(symlinked, ["peer.json"]),
      /regular file/,
    );

    if (process.platform !== "win32") {
      const wrongMode = path.join(root, "wrong-mode");
      await mkdir(wrongMode, { mode: 0o700 });
      const wrongModeFile = path.join(wrongMode, "peer.json");
      await writeFile(wrongModeFile, "{}", { mode: 0o600 });
      await chmod(wrongModeFile, 0o644);
      await assert.rejects(
        () => validateStateDirectory(wrongMode, ["peer.json"]),
        /owner-only permissions/,
      );
    }

    const existingDirectory = path.join(root, "existing-directory");
    await writeStateDirectoryAtomically(
      existingDirectory,
      new Map([["peer.json", "old\n"]]),
    );
    await assert.rejects(
      writeStateDirectoryAtomically(
        existingDirectory,
        new Map([["peer.json", "new\n"]]),
      ),
    );
    assert.equal(await readFile(path.join(existingDirectory, "peer.json"), "utf8"), "old\n");
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith("existing-directory.tmp-")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state file writes fail before creating artifacts when the state directory is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-state-files-missing-"));
  try {
    const missing = path.join(root, "missing");
    await assert.rejects(
      writeStateFileAtomically(missing, "peer.json", "data\n"),
      /ENOENT/,
    );
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(
      lstat(missing),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
