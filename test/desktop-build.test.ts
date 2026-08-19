import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  desktopAppBundle,
  desktopBootstrapAssetPathForTarget,
  desktopBuildCommands,
  desktopBuildPlan,
  requestedTarget,
} from "../scripts/build-desktop.js";
import {
  desktopInstallPath,
  quitRunningDesktop,
  replaceDesktopApp,
} from "../scripts/install-desktop.js";

const repository = process.cwd();

test("desktop build targets an unsigned Apple Silicon Bare app", () => {
  const tools = {
    node: "/runtime/bin/node",
    npm: "/runtime/bin/npm",
  };

  assert.equal(
    desktopAppBundle(repository),
    path.join(repository, "dist", "desktop", "Kepos.app"),
  );
  assert.deepEqual(desktopBuildCommands(repository, tools), [
    {
      command: "tsc",
      arguments: [
        "-b",
        "--clean",
        "packages/bare-host-protocol",
        "packages/kepos-android-worklet",
      ],
    },
    {
      command: "tsc",
      arguments: [
        "-b",
        "packages/bare-host-protocol",
        "packages/kepos-android-worklet",
      ],
    },
    {
      command: "tsc",
      arguments: ["-p", "tsconfig.desktop.json"],
    },
    {
      command: "bare-make",
      arguments: [
        "generate",
        "--source",
        path.join(repository, "vendor", "holepunch", "bare-app-kit"),
        "--build",
        path.join(
          repository,
          "vendor",
          "holepunch",
          "bare-app-kit",
          "build",
        ),
        "--platform",
        "darwin",
        "--arch",
        "arm64",
        "--define",
        `CMAKE_PREFIX_PATH:PATH=${path.join(repository, "node_modules")}`,
        "--define",
        "FETCHCONTENT_UPDATES_DISCONNECTED:BOOL=ON",
        "--define",
        `node:FILEPATH=${tools.node}`,
        "--define",
        `npm:FILEPATH=${tools.npm}`,
      ],
    },
    {
      command: "bare-make",
      arguments: [
        "build",
        "--build",
        path.join(
          repository,
          "vendor",
          "holepunch",
          "bare-app-kit",
          "build",
        ),
      ],
    },
    {
      command: "bare-make",
      arguments: [
        "install",
        "--build",
        path.join(
          repository,
          "vendor",
          "holepunch",
          "bare-app-kit",
          "build",
        ),
        "--prefix",
        path.join(
          repository,
          "vendor",
          "holepunch",
          "bare-app-kit",
          "prebuilds",
        ),
      ],
    },
    {
      command: "bare-make",
      arguments: [
        "generate",
        "--source",
        path.join(repository, "vendor", "holepunch", "bare-web-kit"),
        "--build",
        path.join(repository, "vendor", "holepunch", "bare-web-kit", "build"),
        "--platform",
        "darwin",
        "--arch",
        "arm64",
        "--define",
        `CMAKE_PREFIX_PATH:PATH=${path.join(repository, "node_modules")}`,
        "--define",
        `npm:FILEPATH=${tools.npm}`,
      ],
    },
    {
      command: "bare-make",
      arguments: [
        "build",
        "--build",
        path.join(repository, "vendor", "holepunch", "bare-web-kit", "build"),
      ],
    },
    {
      command: "bare-make",
      arguments: [
        "install",
        "--build",
        path.join(repository, "vendor", "holepunch", "bare-web-kit", "build"),
        "--prefix",
        path.join(
          repository,
          "vendor",
          "holepunch",
          "bare-web-kit",
          "prebuilds",
        ),
      ],
    },
    {
      command: "bare-build",
      arguments: [
        "--base",
        repository,
        "--host",
        "darwin-arm64",
        "--out",
        path.join(repository, "dist", "desktop"),
        "--runtime",
        "bare-native/runtime",
        "--identifier",
        "io.github.ttalab.kepos",
        "--icon",
        path.join(repository, "apps", "desktop", "assets", "Kepos.icns"),
        "--name",
        "Kepos",
        path.join(
          repository,
          ".build",
          "desktop",
          "apps",
          "desktop",
          "src",
          "main.js",
        ),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        path.join(
          repository,
          "dist",
          "desktop",
          "Kepos.app",
          "Contents",
          "Frameworks",
        ),
        path.join(repository, "node_modules", "bare-process"),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        path.join(
          repository,
          "dist",
          "desktop",
          "Kepos.app",
          "Contents",
          "Frameworks",
        ),
        path.join(repository, "vendor", "holepunch", "bare-app-kit"),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        path.join(
          repository,
          "dist",
          "desktop",
          "Kepos.app",
          "Contents",
          "Frameworks",
        ),
        path.join(repository, "vendor", "holepunch", "bare-web-kit"),
      ],
    },
  ]);
});

test("macOS desktop build packages the bootstrap beside its executable", () => {
  const repository = "/checkout";
  assert.equal(
    desktopBootstrapAssetPathForTarget(repository, "darwin-arm64"),
    path.join(
      repository,
      "dist",
      "desktop",
      "Kepos.app",
      "Contents",
      "Resources",
      "kepos-bootstrap.json",
    ),
  );
});

test("desktop Windows plan builds an unpackaged WinUI directory and links native shims", () => {
  const repository = "/checkout";
  const plan = desktopBuildPlan("win32-x64");
  const previousBuildRoot = process.env.KEPOS_WINDOWS_NATIVE_BUILD_ROOT;
  process.env.KEPOS_WINDOWS_NATIVE_BUILD_ROOT = "/short-native-build";
  const commands = plan.commands(repository, {
    node: "C:\\tools\\node.exe",
    npm: "C:\\tools\\npm.cmd",
  });
  const makeGenerate = commands.find(
    ({ command, arguments: arguments_ }) =>
      command === "bare-make" && arguments_.includes("generate"),
  );
  const bareBuild = commands.find(({ command }) => command === "bare-build");
  const links = commands.filter(({ command }) => command === "bare-link");
  if (previousBuildRoot === undefined) {
    delete process.env.KEPOS_WINDOWS_NATIVE_BUILD_ROOT;
  } else {
    process.env.KEPOS_WINDOWS_NATIVE_BUILD_ROOT = previousBuildRoot;
  }

  assert.ok(
    makeGenerate?.arguments.includes(
      path.join("/short-native-build", "winui"),
    ),
  );
  assert.ok(makeGenerate?.arguments.includes("--platform"));
  assert.ok(makeGenerate?.arguments.includes("win32"));
  assert.ok(makeGenerate?.arguments.includes("--arch"));
  assert.ok(makeGenerate?.arguments.includes("x64"));
  assert.ok(
    makeGenerate?.arguments.includes("BARE_WIN_UI_TESTING:BOOL=OFF"),
  );
  assert.equal(
    plan.outputDirectory(repository),
    path.join(repository, "dist", "desktop", "Kepos"),
  );
  assert.ok(
    bareBuild?.arguments.includes(
      path.join(repository, "apps", "desktop", "assets", "Kepos.ico"),
    ),
  );
  assert.equal(bareBuild?.arguments.includes("--package"), false);
  assert.ok(bareBuild?.arguments.includes("--description"));
  assert.ok(
    links.every(({ arguments: arguments_ }) =>
      arguments_.includes(path.join(repository, "dist", "desktop", "Kepos", "App")),
    ),
  );
  assert.ok(
    links.some(({ arguments: arguments_ }) =>
      arguments_.some((argument) => argument.endsWith("bare-win-ui")),
    ),
  );
  assert.ok(
    links.some(({ arguments: arguments_ }) =>
      arguments_.some((argument) => argument.endsWith("bare-process")),
    ),
  );
});

test("desktop target parsing and planning reject missing or unknown targets", () => {
  assert.equal(requestedTarget(["--target", "win32-x64"]), "win32-x64");
  assert.throws(() => requestedTarget(["--target"]), /missing value/);
  assert.throws(() => requestedTarget(["--target=win32"]), /unsupported desktop build target/);
  assert.throws(
    () => desktopBuildPlan("win32"),
    /unsupported desktop build target/,
  );
});

test("desktop output is ignored without ignoring desktop source", async () => {
  const gitignore = await readFile(path.join(repository, ".gitignore"), "utf8");

  assert.match(gitignore, /^dist\/desktop\/$/m);
  assert.doesNotMatch(gitignore, /^apps\/desktop\/$/m);
});

test("desktop install has one canonical npm command", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    packageJson.scripts?.["desktop:install"],
    "npm run desktop:build && tsx scripts/install-desktop.ts",
  );
});

test("desktop native forks are submodules without install-time patches", async () => {
  const gitmodules = await readFile(
    path.join(repository, ".gitmodules"),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.match(
    gitmodules,
    /path = vendor\/holepunch\/bare-app-kit\r?\n\s+url = https:\/\/github\.com\/LamplitIsles\/bare-app-kit\.git/,
  );
  assert.equal(packageJson.scripts?.postinstall, undefined);
  assert.equal(packageJson.devDependencies?.["patch-package"], undefined);
});

test("desktop installer replaces the app bundle without retaining stale files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kepos-install-test-"));
  const source = path.join(temporary, "build", "Kepos.app");
  const target = desktopInstallPath(
    path.join(temporary, "home"),
  );
  try {
    await mkdir(path.join(source, "Contents"), { recursive: true });
    await writeFile(path.join(source, "Contents", "version"), "new");
    await mkdir(path.join(target, "Contents"), { recursive: true });
    await writeFile(path.join(target, "Contents", "version"), "old");
    await writeFile(path.join(target, "stale"), "remove me");

    await replaceDesktopApp(source, target);

    assert.equal(
      await readFile(path.join(target, "Contents", "version"), "utf8"),
      "new",
    );
    await assert.rejects(readFile(path.join(target, "stale"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("desktop installer skips bundle lookup when Kepos is not running", async () => {
  let quitRequests = 0;

  await quitRunningDesktop(
    async () => false,
    async () => {
      quitRequests++;
    },
  );

  assert.equal(quitRequests, 0);
});

test("desktop maps every added Node dependency to Bare", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    imports?: Record<string, { bare?: string; default?: string }>;
  };

  for (const [nodeModule, bareModule] of [
    ["node:crypto", "bare-crypto"],
    ["node:events", "bare-events"],
    ["node:os", "bare-os"],
    ["node:url", "bare-url"],
  ]) {
    assert.deepEqual(packageJson.imports?.[nodeModule], {
      bare: bareModule,
      default: nodeModule,
    });
    assert.equal(typeof packageJson.dependencies?.[bareModule], "string");
  }
});

test("desktop publisher requires no Home static assets", async () => {
  const source = await readFile(
    path.join(repository, "src", "home", "server.ts"),
    "utf8",
  );
  const build = await readFile(
    path.join(repository, "scripts", "build-desktop.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /import\.meta\.asset|home\/index|home\/styles/);
  assert.doesNotMatch(build, /copyDesktopAssets|\.build["'], ["']desktop["'], ["']home/);
  assert.match(
    build,
    /rm\(path\.join\(repository, "\.build", "desktop"\)/,
  );
});
