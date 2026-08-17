import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  const winUiBuild = path.join(winUi, "build");
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
): Promise<void> {
  const plan = desktopBuildPlan(target);
  await rm(path.join(repository, "dist", "desktop"), {
    force: true,
    recursive: true,
  });
  await rm(path.join(repository, ".build", "desktop"), {
    force: true,
    recursive: true,
  });
  for (const command of plan.commands(repository, tools)) {
    await run(repository, command, target);
  }
  await plan.validate(repository);
}

async function validateDarwinOutput(repository: string): Promise<void> {
  const bundle = desktopAppBundle(repository);
  await requireFile(path.join(bundle, "Contents", "MacOS", "Kepos"));
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
  await requireFile(path.join(app, "AppxManifest.xml"));
  await requireFile(path.join(app, "Assets", "Logo.ico"));
  for (const required of [
    "bare-win-ui-",
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.WindowsAppRuntime.Bootstrap.dll",
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

function commandPath(repository: string, command: string, target: DesktopTarget): string {
  const bin = path.join(repository, "node_modules", ".bin");
  const base = path.join(bin, command);
  if (target === "win32-x64") return `${base}.cmd`;
  return base;
}

async function run(
  repository: string,
  build: DesktopBuildCommand,
  target: DesktopTarget,
): Promise<void> {
  const executable = commandPath(repository, build.command, target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, build.arguments, {
      cwd: repository,
      stdio: "inherit",
      shell: target === "win32-x64",
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

const repository = fileURLToPath(new URL("..", import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = requestedTarget(process.argv.slice(2)) ?? desktopTargetForPlatform();
  await runDesktopBuild(repository, target);
  process.stdout.write(`Desktop app ready: ${desktopBuildPlan(target).outputDirectory(repository)}\n`);
}
