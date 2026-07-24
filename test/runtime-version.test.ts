import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

test("package metadata owns the supported runtime and canonical checks", async () => {
  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as {
    devEngines?: unknown;
    engines?: unknown;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.engines, {
    node: ">=22 <23",
    npm: ">=10 <11",
  });
  assert.deepEqual(packageJson.devEngines, {
    runtime: {
      name: "node",
      version: ">=22 <23",
      onFail: "error",
    },
    packageManager: {
      name: "npm",
      version: ">=10 <11",
      onFail: "error",
    },
  });
  assert.equal(
    packageJson.scripts?.check,
    "npm run build:packages && npm run typecheck && npm run desktop:typecheck && npm run test:coverage && npm run check:home",
  );
  assert.match(
    packageJson.scripts?.test ?? "",
    /--test "test\/\*\*\/\*\.test\.ts"/u,
  );
  const coverage = packageJson.scripts?.["test:coverage"] ?? "";
  assert.match(coverage, /"test\/\*\*\/\*\.test\.ts"/u);
  assert.match(coverage, /--test-coverage-include="src\/\*\*\/\*\.ts"/u);
  assert.match(coverage, /--test-coverage-lines=90/u);
  assert.match(coverage, /--test-coverage-branches=80/u);
  assert.match(coverage, /--test-coverage-functions=90/u);
  assert.match(coverage, /--test-reporter-destination=lcov\.info/u);
  await assert.rejects(
    () => access("scripts/check-runtime.mjs"),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );

  const lefthook = await readFile("lefthook.yml", "utf8");
  assert.match(lefthook, /^lefthook: npm exec --offline -- lefthook$/mu);
});
