import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

test("Bare Kit fetcher gives aria2c a resumable parallel download", async () => {
  const fetcher = await import("../scripts/fetch-bare-kit.js");

  assert.deepEqual(
    fetcher.aria2cArguments({
      url: "https://example.invalid/prebuilds.zip",
      partialArchive: "/tmp/bare-kit/prebuilds.zip.partial",
      proxyUrl: "http://127.0.0.1:7890",
    }),
    [
      "--continue=true",
      "--file-allocation=none",
      "--max-connection-per-server=8",
      "--min-split-size=1M",
      "--split=8",
      "--all-proxy=http://127.0.0.1:7890",
      "--dir=/tmp/bare-kit",
      "--out=prebuilds.zip.partial",
      "https://example.invalid/prebuilds.zip",
    ],
  );
});

test("Bare Kit fetcher honors the standard HTTPS proxy environment", async () => {
  const fetcher = await import("../scripts/fetch-bare-kit.js");

  assert.equal(
    fetcher.proxyUrlFromEnvironment({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7891",
    }),
    "http://127.0.0.1:7890",
  );
  assert.equal(fetcher.proxyUrlFromEnvironment({}), undefined);
});

test("Bare Kit fetcher is a checked-in build input", async () => {
  const script = new URL("../scripts/fetch-bare-kit.ts", import.meta.url);

  await assert.doesNotReject(access(script));
});

test("Bare Kit fetcher downloads and verifies a missing archive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-bare-kit-"));
  try {
    const archivePath = path.join(directory, "prebuilds.zip");
    const fetcher = await import("../scripts/fetch-bare-kit.js");
    let requestedUrl: string | URL | Request | undefined;

    await fetcher.ensureArchive({
      archivePath,
      expected: {
        url: "https://example.invalid/prebuilds.zip",
        size: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
      fetchImpl: (async (input) => {
        requestedUrl = input;
        return new Response("hello", { status: 200 });
      }) as typeof fetch,
    });

    assert.equal(requestedUrl, "https://example.invalid/prebuilds.zip");
    assert.equal(await readFile(archivePath, "utf8"), "hello");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bare Kit fetcher accepts a Node download stream", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-bare-kit-"));
  try {
    const archivePath = path.join(directory, "prebuilds.zip");
    const fetcher = await import("../scripts/fetch-bare-kit.js");

    await fetcher.ensureArchive({
      archivePath,
      expected: {
        url: "https://example.invalid/prebuilds.zip",
        size: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        body: Readable.from("hello"),
      })) as unknown as typeof fetch,
    });

    assert.equal(await readFile(archivePath, "utf8"), "hello");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bare Kit fetcher resumes a reset download", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-bare-kit-"));
  try {
    const archivePath = path.join(directory, "prebuilds.zip");
    const fetcher = await import("../scripts/fetch-bare-kit.js");
    const requestedRanges: Array<string | null> = [];

    await fetcher.ensureArchive({
      archivePath,
      expected: {
        url: "https://example.invalid/prebuilds.zip",
        size: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
      fetchImpl: (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const headers = new Headers(init?.headers);
        requestedRanges.push(headers.get("range"));
        if (requestedRanges.length === 1) {
          await writeFile(`${archivePath}.partial`, "he");
          throw new Error("connection reset");
        }
        return {
          ok: true,
          status: 206,
          body: Readable.from("llo"),
        };
      }) as unknown as typeof fetch,
    });

    assert.deepEqual(requestedRanges, [null, "bytes=2-"]);
    assert.equal(await readFile(archivePath, "utf8"), "hello");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bare Kit fetcher exposes archive verification", async () => {
  const fetcher = await import("../scripts/fetch-bare-kit.js");

  assert.equal(typeof fetcher.verifyArchive, "function");
});

test("Bare Kit archive verification accepts exact bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-bare-kit-"));
  try {
    const archivePath = path.join(directory, "prebuilds.zip");
    await writeFile(archivePath, "hello");
    const fetcher = await import("../scripts/fetch-bare-kit.js");

    await assert.doesNotReject(
      fetcher.verifyArchive(archivePath, {
        size: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bare Kit fetcher reuses a verified cached archive", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-bare-kit-"));
  try {
    const archivePath = path.join(directory, "prebuilds.zip");
    await writeFile(archivePath, "hello");
    let fetched = false;
    const fetcher = await import("../scripts/fetch-bare-kit.js");

    await fetcher.ensureArchive({
      archivePath,
      expected: {
        size: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      },
      fetchImpl: async () => {
        fetched = true;
        throw new Error("cache should avoid network access");
      },
    });

    assert.equal(fetched, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bare Kit installer exposes only the Android prebuild to Gradle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-bare-kit-"));
  try {
    const destination = path.join(directory, "libs", "bare-kit");
    const fetcher = await import("../scripts/fetch-bare-kit.js");

    await fetcher.installAndroidPrebuild({
      archivePath: path.join(directory, "prebuilds.zip"),
      destination,
      extractImpl: async (_archivePath, options) => {
        const source = path.join(options.dir, "android", "bare-kit");
        await mkdir(path.join(source, "jni", "arm64-v8a"), {
          recursive: true,
        });
        await writeFile(path.join(source, "classes.jar"), "jar");
        await writeFile(
          path.join(source, "jni", "arm64-v8a", "libbare-kit.so"),
          "native",
        );
      },
    });

    assert.equal(await readFile(path.join(destination, "classes.jar"), "utf8"), "jar");
    assert.equal(
      await readFile(
        path.join(destination, "jni", "arm64-v8a", "libbare-kit.so"),
        "utf8",
      ),
      "native",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android build embeds only bootstrap endpoints from the local Kepos config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-android-bootstrap-"));
  try {
    const configHome = path.join(directory, "config");
    const configDirectory = path.join(
      configHome,
      process.platform === "win32" ? "Kepos" : "kepos",
    );
    const outputPath = path.join(directory, "assets", "kepos-bootstrap.json");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      path.join(configDirectory, "config.toml"),
      [
        "[network]",
        'bootstrap = ["bootstrap-one.example:49737", "bootstrap-two.example:49738"]',
        "",
        "[subscriber]",
        "gateway_port = 17480",
        "",
        "[publisher]",
        'display_name = "incomplete and irrelevant to Android"',
        "",
      ].join("\n"),
    );

    const builder = await import("../scripts/bootstrap-config.js").catch(
      () => null,
    ) as null | {
      writeKeposBootstrapAsset(options: {
        outputPath: string;
        environment: NodeJS.ProcessEnv;
      }): Promise<void>;
    };
    assert.notEqual(builder, null, "missing shared bootstrap asset builder");
    await builder!.writeKeposBootstrapAsset({
      outputPath,
      environment:
        process.platform === "win32"
          ? { APPDATA: configHome }
          : { XDG_CONFIG_HOME: configHome },
    });

    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), [
      { host: "bootstrap-one.example", port: 49_737 },
      { host: "bootstrap-two.example", port: 49_738 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared bootstrap generation replaces only its target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-android-bootstrap-"));
  try {
    const outputDirectory = path.join(directory, "assets");
    const outputPath = path.join(outputDirectory, "kepos-bootstrap.json");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, "old\n");
    await writeFile(path.join(outputDirectory, "stale-full-config.json"), "secret");
    const builder = await import("../scripts/bootstrap-config.js") as {
      writeKeposBootstrapAsset(options: {
        outputPath: string;
        environment: NodeJS.ProcessEnv;
      }): Promise<void>;
    };

    await builder.writeKeposBootstrapAsset({
      outputPath,
      environment: { XDG_CONFIG_HOME: path.join(directory, "missing") },
    });

    assert.deepEqual(await readdir(outputDirectory), [
      "kepos-bootstrap.json",
      "stale-full-config.json",
    ]);
    assert.equal(await readFile(outputPath, "utf8"), "null\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android build leaves bootstrap selection to HyperDHT without local config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-android-bootstrap-"));
  try {
    const outputPath = path.join(directory, "assets", "kepos-bootstrap.json");
    const builder = await import("../scripts/bootstrap-config.js").catch(
      () => null,
    ) as null | {
      writeKeposBootstrapAsset(options: {
        outputPath: string;
        environment: NodeJS.ProcessEnv;
      }): Promise<void>;
    };
    assert.notEqual(builder, null, "missing shared bootstrap asset builder");
    await builder!.writeKeposBootstrapAsset({
      outputPath,
      environment: { XDG_CONFIG_HOME: path.join(directory, "missing") },
    });

    assert.equal(await readFile(outputPath, "utf8"), "null\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android Worklet accepts embedded endpoints and treats null as official defaults", async () => {
  const bootstrap = await import("../src/android/bootstrap.js").catch(() => null) as
    | null
    | {
        parseAndroidBootstrapAsset(source: string):
          | Array<{ host: string; port: number }>
          | undefined;
      };
  assert.notEqual(bootstrap, null, "missing Android bootstrap asset parser");
  assert.deepEqual(
    bootstrap!.parseAndroidBootstrapAsset(
      '[{"host":"bootstrap.example","port":49737}]',
    ),
    [{ host: "bootstrap.example", port: 49_737 }],
  );
  assert.equal(bootstrap!.parseAndroidBootstrapAsset("null"), undefined);
  assert.throws(
    () => bootstrap!.parseAndroidBootstrapAsset('[{"host":"","port":0}]'),
    /invalid Android bootstrap asset/,
  );
});
