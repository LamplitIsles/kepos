import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

test("package metadata owns the supported runtime and canonical checks", async () => {
  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as {
    allowScripts?: unknown;
    devEngines?: unknown;
    devDependencies?: Record<string, string>;
    engines?: unknown;
    packageManager?: unknown;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.engines, {
    node: ">=24 <25",
    npm: ">=11 <12",
  });
  assert.deepEqual(packageJson.devEngines, {
    runtime: {
      name: "node",
      version: ">=24 <25",
      onFail: "error",
    },
    packageManager: {
      name: "npm",
      version: ">=11 <12",
      onFail: "error",
    },
  });
  assert.equal(packageJson.packageManager, "npm@11.16.0");
  assert.equal((await readFile(".node-version", "utf8")).trim(), "24.18.1");
  assert.deepEqual(packageJson.allowScripts, {
    "esbuild@0.28.1": true,
    "lefthook@2.1.10": true,
    "workerd@1.20260730.1": true,
  });
  assert.equal(
    packageJson.scripts?.check,
    "npm run build:packages && npm run typecheck && npm run desktop:typecheck && npm run test:coverage && npm run web:verify",
  );
  assert.equal(packageJson.scripts?.["build:home"], undefined);
  assert.equal(packageJson.scripts?.["check:home"], undefined);
  for (const dependency of ["@tailwindcss/cli", "daisyui", "tailwindcss"]) {
    assert.equal(packageJson.devDependencies?.[dependency], undefined);
  }
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
