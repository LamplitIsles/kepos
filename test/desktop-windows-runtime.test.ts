import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  appendFile,
  cp,
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
  stageValidatedWindowsSelfContainedRuntime,
  validateFinalWindowsSelfContainedRuntime,
} from "../scripts/windows/self-contained-runtime.js";

const require = createRequire(import.meta.url);
const adapter = require(
  "../vendor/holepunch/bare-win-ui/cmake/self-contained-runtime.js",
) as {
  generateManifest: (root: string) => unknown;
  serializeManifest: (manifest: unknown) => string;
};

async function makeRuntimeRoot(root: string): Promise<string> {
  const source = path.join(root, "source");
  await mkdir(path.join(source, "en-us"), { recursive: true });
  await writeFile(path.join(source, "Microsoft.WindowsAppRuntime.dll"), "runtime");
  await writeFile(path.join(source, "en-us", "runtime.mui"), "locale");
  await writeFile(path.join(source, "bare.exe"), "excluded executable");
  await writeFile(
    path.join(source, "Microsoft.Web.WebView2.Core.dll"),
    "excluded WebView2",
  );
  adapter.generateManifest(source);
  return source;
}

async function makeProductApp(root: string): Promise<string> {
  const app = path.join(root, "app");
  await mkdir(app, { recursive: true });
  for (const [name, content] of [
    ["Kepos.exe", "executable"],
    ["kepos-bootstrap.json", "[]\n"],
    ["app.bundle", "bundle"],
    ["Microsoft.Web.WebView2.Core.dll", "webview"],
    ["bare-win-ui-0.2.1.dll", "native addon"],
  ] as const) {
    await writeFile(path.join(app, name), content);
  }
  return app;
}

test("Windows runtime staging preserves manifest-governed subdirectories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-windows-runtime-stage-"));
  try {
    const source = await makeRuntimeRoot(root);
    const app = await makeProductApp(root);
    const staged = await stageValidatedWindowsSelfContainedRuntime(source, app);

    assert.equal(staged.fileCount, 2);
    assert.equal(
      await readFile(path.join(app, "en-us", "runtime.mui"), "utf8"),
      "locale",
    );
    assert.equal(
      await readFile(path.join(app, "self-contained-runtime.json"), "utf8"),
      await readFile(path.join(source, "self-contained-runtime.json"), "utf8"),
    );

    const validation = path.join(root, "validation");
    const final = await validateFinalWindowsSelfContainedRuntime(
      source,
      app,
      app,
      staged.productFiles,
      validation,
    );
    assert.equal(final.fileCount, 2);
    assert.equal(final.manifestSha256, staged.manifestSha256);
    assert.equal(
      await readFile(path.join(validation, "en-us", "runtime.mui"), "utf8"),
      "locale",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Windows final runtime validation rejects extra product files", async () => {
  for (const name of ["bare-crypto-999.0.0.dll", "unexpected-product.dll"]) {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "kepos-windows-final-product-"),
    );
    try {
      const source = await makeRuntimeRoot(root);
      const sourceApp = await makeProductApp(root);
      const staged = await stageValidatedWindowsSelfContainedRuntime(
        source,
        sourceApp,
      );
      const finalApp = path.join(root, "final-app");
      await cp(sourceApp, finalApp, { recursive: true });
      await writeFile(path.join(finalApp, name), "injected product\n");

      await assert.rejects(
        validateFinalWindowsSelfContainedRuntime(
          source,
          sourceApp,
          finalApp,
          staged.productFiles,
          path.join(root, "validation"),
        ),
        /unmanifested|product file set/i,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("Windows runtime staging rejects representative adapter payload mutations", async () => {
  const mutations: readonly [string, (source: string) => Promise<void>][] = [
    ["omitted", async (source) => rm(path.join(source, "en-us", "runtime.mui"))],
    ["altered", async (source) => appendFile(path.join(source, "Microsoft.WindowsAppRuntime.dll"), "altered")],
    ["linked", async (source) => symlink("Microsoft.WindowsAppRuntime.dll", path.join(source, "linked-runtime.dll"))],
    ["unexpected", async (source) => writeFile(path.join(source, "unexpected.dll"), "unexpected")],
    ["escaping", async (source) => {
      const manifestPath = path.join(source, "self-contained-runtime.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        files: Array<{ path: string }>;
      };
      manifest.files[0]!.path = "../escape.dll";
      await writeFile(manifestPath, adapter.serializeManifest(manifest));
    }],
  ];

  for (const [label, mutate] of mutations) {
    const root = await mkdtemp(path.join(os.tmpdir(), `kepos-windows-runtime-${label}-`));
    try {
      const source = await makeRuntimeRoot(root);
      await mutate(source);
      const app = path.join(root, "app");
      await mkdir(app, { recursive: true });
      await assert.rejects(
        stageValidatedWindowsSelfContainedRuntime(source, app),
        /Manifest|Payload|payload|link|unmanifested|mismatch|unsafe/i,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});
