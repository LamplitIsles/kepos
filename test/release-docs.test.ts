import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("release docs keep local signing and user verification explicit", async () => {
  const [runbook, readme, androidGuide] = await Promise.all([
    readFile(new URL("../docs/releasing.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/platforms/android.md", import.meta.url), "utf8"),
  ]);
  const docs = `${runbook}\n${readme}\n${androidGuide}`;

  assert.match(runbook, /git tag -a/);
  assert.match(runbook, /git push origin/);
  assert.match(runbook, /gh release/);
  assert.match(runbook, /minisign -Vm/);
  assert.match(runbook, /shasum -a 256 -c SHA256SUMS/);
  assert.match(runbook, /xattr -dr com\.apple\.quarantine \/Applications\/Kepos\.app/);
  assert.match(runbook, /Not notarized/i);
  assert.match(runbook, /ad-hoc signed/i);
  assert.doesNotMatch(runbook, /sudo\s+xattr/);
  assert.doesNotMatch(runbook, /xattr[^\n]*(?:\/Applications\s|Downloads|\*)/);
  assert.doesNotMatch(docs, /distribution not ready/i);
  assert.doesNotMatch(androidGuide, /unsigned|14-day Actions artifact/i);
});
