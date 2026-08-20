import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertBootstrapAssetMatches,
  readBootstrapAssetFile,
  verifyBootstrapAssetFiles,
} from "../scripts/release-bootstrap.js";

async function fixture(): Promise<{
  directory: string;
  expected: string;
  actual: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kepos-release-bootstrap-"));
  const expected = path.join(directory, "expected.json");
  const actual = path.join(directory, "actual.json");
  await writeFile(expected, '[{"host":"bootstrap.example","port":49737}]\n');
  await writeFile(actual, '[{"host":"bootstrap.example","port":49737}]\n');
  return {
    directory,
    expected,
    actual,
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}

test("release bootstrap verification compares one canonical endpoint value", async () => {
  const files = await fixture();
  try {
    await verifyBootstrapAssetFiles({
      expectedPath: files.expected,
      actualPath: files.actual,
      label: "test artifact",
    });
    const value = await readBootstrapAssetFile(files.actual, "test", true);
    assert.deepEqual(value, [{ host: "bootstrap.example", port: 49_737 }]);
  } finally {
    await files.cleanup();
  }
});

test("required release bootstrap verification rejects missing, null, empty, malformed, and unknown fields", async () => {
  const files = await fixture();
  try {
    for (const source of [
      "null\n",
      "[]\n",
      "not-json\n",
      '[{"host":"bootstrap.example","port":49737,"unexpected":true}]\n',
    ]) {
      await writeFile(files.actual, source);
      await assert.rejects(
        verifyBootstrapAssetFiles({
          expectedPath: files.expected,
          actualPath: files.actual,
          label: "test artifact",
        }),
        /bootstrap asset|empty|invalid/i,
      );
    }
    await rm(files.actual);
    await assert.rejects(
      verifyBootstrapAssetFiles({
        expectedPath: files.expected,
        actualPath: files.actual,
        label: "test artifact",
      }),
      /cannot be read/i,
    );
  } finally {
    await files.cleanup();
  }
});

test("release bootstrap comparison does not print endpoint values on mismatch", () => {
  assert.throws(
    () =>
      assertBootstrapAssetMatches(
        [{ host: "secret-bootstrap.example", port: 49_737 }],
        [{ host: "other-bootstrap.example", port: 49_738 }],
        "test artifact",
      ),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch((error as Error).message, /secret-bootstrap|other-bootstrap/);
      return true;
    },
  );
});
