import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface DesktopBuildCommand {
  command: string;
  arguments: string[];
}

export function desktopAppBundle(repository: string): string {
  return path.join(repository, "dist", "desktop", "Kepos.app");
}

export function desktopBuildCommands(
  repository: string,
): DesktopBuildCommand[] {
  const app = desktopAppBundle(repository);
  const frameworks = path.join(app, "Contents", "Frameworks");
  const webKit = path.join(repository, "vendor", "holepunch", "bare-web-kit");
  const webKitBuild = path.join(webKit, "build");
  return [
    { command: "tsc", arguments: ["-p", "tsconfig.desktop.json"] },
    {
      command: "bare-make",
      arguments: [
        "generate",
        "--source",
        webKit,
        "--build",
        webKitBuild,
        "--platform",
        "darwin",
        "--arch",
        "arm64",
        "--define",
        `CMAKE_PREFIX_PATH:PATH=${path.join(repository, "node_modules")}`,
      ],
    },
    {
      command: "bare-make",
      arguments: ["build", "--build", webKitBuild],
    },
    {
      command: "bare-make",
      arguments: [
        "install",
        "--build",
        webKitBuild,
        "--prefix",
        path.join(webKit, "prebuilds"),
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
        frameworks,
        path.join(repository, "node_modules", "bare-process"),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        frameworks,
        path.join(repository, "node_modules", "bare-app-kit"),
      ],
    },
    {
      command: "bare-link",
      arguments: [
        "--host",
        "darwin-arm64",
        "--out",
        frameworks,
        webKit,
      ],
    },
  ];
}

export async function runDesktopBuild(repository: string): Promise<void> {
  await rm(path.join(repository, "dist", "desktop"), {
    force: true,
    recursive: true,
  });
  for (const build of desktopBuildCommands(repository)) {
    await run(repository, build);
  }

  const frameworks = await readdir(
    path.join(desktopAppBundle(repository), "Contents", "Frameworks"),
  );
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

async function run(
  repository: string,
  build: DesktopBuildCommand,
): Promise<void> {
  const executable = path.join(repository, "node_modules", ".bin", build.command);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, build.arguments, {
      cwd: repository,
      stdio: "inherit",
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

const repository = fileURLToPath(new URL("..", import.meta.url));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runDesktopBuild(repository);
  process.stdout.write(`Desktop app ready: ${desktopAppBundle(repository)}\n`);
}
