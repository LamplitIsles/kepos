import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_BOOTSTRAP_ASSET,
  desktopBootstrapAssetPath,
} from "../apps/desktop/src/paths.js";
import {
  parseBootstrapAsset,
  requireBootstrapAsset,
} from "../src/bootstrap-asset.js";
import { writeKeposBootstrapAsset } from "./bootstrap-config.js";
import { stageWindowsSelfContainedRuntime } from "./windows/self-contained-runtime.js";

export type DesktopTarget = "darwin-arm64" | "win32-x64";

const desktopTargets: readonly DesktopTarget[] = ["darwin-arm64", "win32-x64"];

export interface DesktopBuildCommand {
  command: string;
  arguments: string[];
}

export interface DesktopBuildTools {
  node: string;
  npm: string;
}

export interface DesktopBuildOptions {
  bootstrapAssetPath?: string;
  requireBootstrap?: boolean;
  windowsProductFilesOutputPath?: string;
}

export interface DesktopBuildPlan {
  readonly target: DesktopTarget;
  readonly outputDirectory: (repository: string) => string;
  readonly commands: (
    repository: string,
    tools: DesktopBuildTools,
  ) => DesktopBuildCommand[];
  readonly validate: (repository: string) => Promise<void>;
}

const defaultTools = (): DesktopBuildTools => ({
  node: process.execPath,
  npm:
    process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "npm.cmd")
      : (process.env.npm_execpath ??
        path.join(path.dirname(process.execPath), "npm")),
});

export function desktopTargetForPlatform(
  platform: NodeJS.Platform = process.platform,
  architecture = process.arch,
): DesktopTarget {
  if (platform === "darwin" && architecture === "arm64") return "darwin-arm64";
  if (platform === "win32" && architecture === "x64") return "win32-x64";
  throw new Error(
    `unsupported desktop build host: ${platform}-${architecture}; expected darwin-arm64 or win32-x64`,
  );
}

export function desktopAppBundle(repository: string): string {
  return path.join(repository, "dist", "desktop", "Kepos.app");
}

export function desktopWindowsOutput(repository: string): string {
  return path.join(repository, "dist", "desktop");
}

function desktopWindowsApp(repository: string): string {
  return path.join(desktopWindowsOutput(repository), "Kepos");
}

export function desktopBootstrapAssetPathForTarget(
  repository: string,
  target: DesktopTarget,
): string {
  const executable =
    target === "darwin-arm64"
      ? path.join(desktopAppBundle(repository), "Contents", "MacOS", "Kepos")
      : path.join(desktopWindowsApp(repository), "App", "Kepos.exe");
  return desktopBootstrapAssetPath(
    executable,
    target === "darwin-arm64" ? "darwin" : "win32",
  );
}

function sourcePath(repository: string, packageName: string): string {
  return path.join(repository, "vendor", "holepunch", packageName);
}

function compiledEntry(repository: string): string {
  return path.join(
    repository,
    ".build",
    "desktop",
    "apps",
    "desktop",
    "src",
    "main.js",
  );
}

function commonBareBuild(
  repository: string,
  target: DesktopTarget,
  tools: DesktopBuildTools,
): DesktopBuildCommand {
  const isWindows = target === "win32-x64";
  return {
    command: "bare-build",
    arguments: [
      "--base",
      repository,
      "--host",
      target,
      "--out",
      desktopWindowsOutput(repository),
      "--runtime",
      "bare-native/runtime",
      "--identifier",
      "io.github.ttalab.kepos",
      ...(isWindows
        ? [
            "--icon",
            path.join(repository, "apps", "desktop", "assets", "Kepos.ico"),
            "--name",
            "Kepos",
            "--description",
            "Kepos private services, directly connected",
          ]
        : [
            "--icon",
            path.join(repository, "apps", "desktop", "assets", "Kepos.icns"),
            "--name",
            "Kepos",
          ]),
      compiledEntry(repository),
    ],
  };
}

function typescriptBuildCommands(): DesktopBuildCommand[] {
  return [
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
    { command: "tsc", arguments: ["-p", "tsconfig.desktop.json"] },
  ];
}

function darwinPlan(
  repository: string,
  tools: DesktopBuildTools,
): DesktopBuildCommand[] {
  const appKit = sourcePath(repository, "bare-app-kit");
  const webKit = sourcePath(repository, "bare-web-kit");
  const appKitBuild = path.join(appKit, "build");
  const webKitBuild = path.join(webKit, "build");
  const frameworks = path.join(
    desktopAppBundle(repository),
    "Contents",
    "Frameworks",
  );
  const make = (
    source: string,
    build: string,
    npm: boolean,
  ): DesktopBuildCommand[] => [
    {
      command: "bare-make",
      arguments: [
        "generate",
        "--source",
        source,
        "--build",
        build,
        "--platform",
        "darwin",
        "--arch",
        "arm64",
        "--define",
        `CMAKE_PREFIX_PATH:PATH=${path.join(repository, "node_modules")}`,
        ...(source === appKit
          ? ["--define", "FETCHCONTENT_UPDATES_DISCONNECTED:BOOL=ON"]
          : []),
        ...(source === appKit
          ? ["--define", `node:FILEPATH=${tools.node}`]
          : []),
        ...(npm ? ["--define", `npm:FILEPATH=${tools.npm}`] : []),
      ],
    },
    { command: "bare-make", arguments: ["build", "--build", build] },
    {
      command: "bare-make",
      arguments: [
        "install",
        "--build",
        build,
        "--prefix",
        path.join(source, "prebuilds"),
      ],
    },
  ];
  return [
    ...typescriptBuildCommands(),
    ...make(appKit, appKitBuild, true),
    ...make(webKit, webKitBuild, true),
    commonBareBuild(repository, "darwin-arm64", tools),
    ...[
      path.join(repository, "node_modules", "bare-process"),
      appKit,
      webKit,
    ].map((entry) => ({
      command: "bare-link",
      arguments: ["--host", "darwin-arm64", "--out", frameworks, entry],
    })),
  ];
}

function windowsPlan(
  repository: string,
  tools: DesktopBuildTools,
): DesktopBuildCommand[] {
  const winUi = sourcePath(repository, "bare-win-ui");
  const nativeBuildRoot = process.env.KEPOS_WINDOWS_NATIVE_BUILD_ROOT;
  if (nativeBuildRoot && !path.isAbsolute(nativeBuildRoot)) {
    throw new Error("KEPOS_WINDOWS_NATIVE_BUILD_ROOT must be absolute");
  }
  const winUiBuild = nativeBuildRoot
    ? path.join(nativeBuildRoot, "winui")
    : path.join(winUi, "build");
  return [
    ...typescriptBuildCommands(),
    {
      command: "bare-make",
      arguments: [
        "generate",
        "--source",
        winUi,
        "--build",
        winUiBuild,
        "--platform",
        "win32",
        "--arch",
        "x64",
        "--define",
        `CMAKE_PREFIX_PATH:PATH=${path.join(repository, "node_modules")}`,
        "--define",
        "FETCHCONTENT_UPDATES_DISCONNECTED:BOOL=ON",
        "--define",
        "BARE_WIN_UI_TESTING:BOOL=OFF",
        "--define",
        `node:FILEPATH=${tools.node}`,
        "--define",
        `npm:FILEPATH=${tools.npm}`,
      ],
    },
    { command: "bare-make", arguments: ["build", "--build", winUiBuild] },
    {
      command: "bare-make",
      arguments: [
        "install",
        "--build",
        winUiBuild,
        "--prefix",
        path.join(winUi, "prebuilds"),
      ],
    },
    commonBareBuild(repository, "win32-x64", tools),
    {
      command: "bare-link",
      arguments: [
        "--host",
        "win32-x64",
        "--out",
        path.join(desktopWindowsApp(repository), "App"),
        path.join(repository, "node_modules", "bare-process"),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "win32-x64",
        "--out",
        path.join(desktopWindowsApp(repository), "App"),
        winUi,
      ],
    },
  ];
}

function validateDesktopTarget(target: unknown): DesktopTarget {
  if (
    typeof target !== "string" ||
    !desktopTargets.includes(target as DesktopTarget)
  ) {
    throw new Error(
      `unsupported desktop build target: ${String(target)}; expected ${desktopTargets.join(" or ")}`,
    );
  }
  return target as DesktopTarget;
}

export function desktopBuildPlan(target: unknown): DesktopBuildPlan {
  const validatedTarget = validateDesktopTarget(target);
  if (validatedTarget === "darwin-arm64") {
    return {
      target: validatedTarget,
      outputDirectory: desktopAppBundle,
      commands: darwinPlan,
      validate: validateDarwinOutput,
    };
  }
  return {
    target: validatedTarget,
    outputDirectory: desktopWindowsApp,
    commands: windowsPlan,
    validate: validateWindowsOutput,
  };
}

export function desktopBuildCommands(
  repository: string,
  tools: DesktopBuildTools = defaultTools(),
  target: DesktopTarget = "darwin-arm64",
): DesktopBuildCommand[] {
  return desktopBuildPlan(target).commands(repository, tools);
}

export async function runDesktopBuild(
  repository: string,
  target: DesktopTarget = desktopTargetForPlatform(),
  tools: DesktopBuildTools = defaultTools(),
  options: DesktopBuildOptions = {},
): Promise<void> {
  const plan = desktopBuildPlan(target);
  const requireBootstrap =
    options.requireBootstrap ?? process.env.KEPOS_BOOTSTRAP_REQUIRED === "1";
  const stagingDirectory = path.join(repository, ".build", "desktop-bootstrap");
  const stagingPath = path.join(stagingDirectory, DESKTOP_BOOTSTRAP_ASSET);

  await rm(path.join(repository, "dist", "desktop"), {
    force: true,
    recursive: true,
  });
  await rm(path.join(repository, ".build", "desktop"), {
    force: true,
    recursive: true,
  });
  await rm(stagingDirectory, { force: true, recursive: true });

  try {
    let bootstrapSource = "null\n";
    if (target === "darwin-arm64") {
      await writeKeposBootstrapAsset({
        outputPath: stagingPath,
        mode: 0o644,
        required: requireBootstrap,
      });
      bootstrapSource = await readFile(stagingPath, "utf8");
    } else if (options.bootstrapAssetPath !== undefined) {
      bootstrapSource = await readDesktopBootstrapAssetInput(
        options.bootstrapAssetPath,
        requireBootstrap,
      );
    } else if (requireBootstrap) {
      throw new Error("required Windows bootstrap asset input is missing");
    }

    for (const command of plan.commands(repository, tools)) {
      await run(repository, command, target);
    }

    if (target === "win32-x64") {
      const runtime = await stageWindowsSelfContainedRuntime(repository);
      if (options.windowsProductFilesOutputPath !== undefined) {
        await mkdir(path.dirname(options.windowsProductFilesOutputPath), {
          recursive: true,
        });
        await writeFile(
          options.windowsProductFilesOutputPath,
          `${JSON.stringify(runtime.productFiles, null, 2)}\n`,
          { mode: 0o644 },
        );
      }
      process.stdout.write(
        `Windows self-contained runtime staged: ${runtime.fileCount} runtime files, ${runtime.productFiles.length} product files, manifest ${runtime.manifestSha256}\n`,
      );
    }

    const outputPath = desktopBootstrapAssetPathForTarget(repository, target);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bootstrapSource, { mode: 0o644 });
    await plan.validate(repository);
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
}

export async function readDesktopBootstrapAssetInput(
  inputPath: string,
  required: boolean,
): Promise<string> {
  let source: string;
  try {
    const metadata = await lstat(inputPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("desktop bootstrap asset input must be a regular file");
    }
    source = await readFile(inputPath, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("regular file")) {
      throw error;
    }
    throw new Error(`cannot read desktop bootstrap asset input: ${inputPath}`, {
      cause: error,
    });
  }

  let bootstrap;
  try {
    bootstrap = parseBootstrapAsset(source);
  } catch (error) {
    throw new Error("invalid desktop bootstrap asset input", { cause: error });
  }
  if (required) requireBootstrapAsset(bootstrap);
  return source;
}

async function validateDarwinOutput(repository: string): Promise<void> {
  const bundle = desktopAppBundle(repository);
  await requireFile(path.join(bundle, "Contents", "MacOS", "Kepos"));
  await requireFile(
    path.join(bundle, "Contents", "Resources", DESKTOP_BOOTSTRAP_ASSET),
  );
  const frameworks = await readdir(path.join(bundle, "Contents", "Frameworks"));
  for (const required of [
    "bare-abort.",
    "bare-app-kit.",
    "bare-hrtime.",
    "bare-posix.",
    "bare-signals.",
    "bare-stdio.",
    "bare-tty.",
    "bare-web-kit.",
  ]) {
    if (!frameworks.some((name) => name.startsWith(required))) {
      throw new Error(`desktop app is missing ${required} framework`);
    }
  }
}

async function validateWindowsOutput(repository: string): Promise<void> {
  const app = desktopWindowsApp(repository);
  const output = path.join(app, "App");
  await requireFile(path.join(output, "Kepos.exe"));
  await requireFile(path.join(output, DESKTOP_BOOTSTRAP_ASSET));
  await requireFile(path.join(output, "self-contained-runtime.json"));
  await requireFile(path.join(output, "Microsoft.WindowsAppRuntime.dll"));
  await requireFile(path.join(app, "AppxManifest.xml"));
  await requireFile(path.join(app, "Assets", "Logo.ico"));
  for (const required of [
    "bare-win-ui-",
    "Microsoft.Web.WebView2.Core.dll",
  ]) {
    const files = await readdir(output);
    if (
      !files.some((name) =>
        required.endsWith(".dll")
          ? name === required
          : name.startsWith(required) && name.endsWith(".dll"),
      )
    ) {
      throw new Error(`Windows desktop output is missing ${required}`);
    }
  }
}

async function requireFile(file: string): Promise<void> {
  try {
    const details = await stat(file);
    if (!details.isFile()) throw new Error(`${file} is not a file`);
  } catch (error) {
    throw new Error(`desktop output is missing ${file}`, { cause: error });
  }
}

function commandPath(repository: string, command: string): string {
  return path.join(repository, "node_modules", ".bin", command);
}

const windowsCommandEntrypoints: Readonly<Record<string, string>> = {
  tsc: "typescript/bin/tsc",
  "bare-make": "bare-make/bin.js",
  "bare-build": "bare-build/bin.js",
  "bare-link": "bare-link/bin.js",
};

async function run(
  repository: string,
  build: DesktopBuildCommand,
  target: DesktopTarget,
): Promise<void> {
  const windows = target === "win32-x64";
  const windowsEntrypoint = windowsCommandEntrypoints[build.command];
  if (windows && windowsEntrypoint === undefined) {
    throw new Error(`unsupported Windows desktop build command: ${build.command}`);
  }
  const command = windows ? process.execPath : commandPath(repository, build.command);
  const arguments_ = windows
    ? [path.join(repository, "node_modules", windowsEntrypoint), ...build.arguments]
    : build.arguments;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repository,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${build.command} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
        ),
      );
    });
  });
}

export function requestedBootstrapAsset(
  arguments_: readonly string[],
): string | undefined {
  const inline = arguments_.find((argument) =>
    argument.startsWith("--bootstrap-asset="),
  );
  const index = arguments_.indexOf("--bootstrap-asset");
  if (inline !== undefined && index !== -1) {
    throw new Error("bootstrap asset must be specified only once");
  }
  if (inline !== undefined) {
    const value = inline.slice("--bootstrap-asset=".length);
    if (!value) throw new Error("missing value for --bootstrap-asset");
    return value;
  }
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("missing value for --bootstrap-asset");
  }
  if (arguments_.indexOf("--bootstrap-asset", index + 1) !== -1) {
    throw new Error("bootstrap asset must be specified only once");
  }
  return value;
}

export function requestedTarget(
  arguments_: readonly string[],
): DesktopTarget | undefined {
  const inline = arguments_.find((argument) => argument.startsWith("--target="));
  if (inline) return validateDesktopTarget(inline.slice("--target=".length));

  const index = arguments_.indexOf("--target");
  if (index === -1) return undefined;

  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("missing value for --target; expected darwin-arm64 or win32-x64");
  }
  return validateDesktopTarget(value);
}

export function requestedWindowsProductFilesOutput(
  arguments_: readonly string[],
): string | undefined {
  const index = arguments_.indexOf("--windows-product-files-output");
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("missing value for --windows-product-files-output");
  }
  if (arguments_.indexOf("--windows-product-files-output", index + 1) !== -1) {
    throw new Error("windows product files output must be specified only once");
  }
  return value;
}

const repository = fileURLToPath(new URL("..", import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  const target = requestedTarget(arguments_) ?? desktopTargetForPlatform();
  await runDesktopBuild(repository, target, defaultTools(), {
    bootstrapAssetPath: requestedBootstrapAsset(arguments_),
    requireBootstrap:
      arguments_.filter((argument) => argument === "--require-bootstrap").length > 0 ||
      process.env.KEPOS_BOOTSTRAP_REQUIRED === "1",
    windowsProductFilesOutputPath: requestedWindowsProductFilesOutput(arguments_),
  });
  process.stdout.write(`Desktop app ready: ${desktopBuildPlan(target).outputDirectory(repository)}\n`);
}
