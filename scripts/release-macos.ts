import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseGitState,
  parseReleaseTag,
  prepareReleaseArtifactDirectory,
  releaseSubprocessEnvironment,
  type ReleaseMode,
} from "./release-version.js";

export type MacosReleaseCommandKind =
  | "build"
  | "architecture"
  | "version-short"
  | "version-build"
  | "sign-framework"
  | "sign-app"
  | "verify-app"
  | "inspect-signature"
  | "inspect-version-short"
  | "inspect-version-build"
  | "archive"
  | "extract"
  | "verify-archive"
  | "inspect-archive-signature"
  | "inspect-archive-version-short"
  | "inspect-archive-version-build"
  | "inspect-archive-architecture";

export interface MacosReleaseCommand {
  kind: MacosReleaseCommandKind;
  command: string;
  arguments: string[];
}

export function macosReleaseEnvironment(
  kind: MacosReleaseCommandKind,
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = releaseSubprocessEnvironment(baseEnvironment);
  if (kind === "build") environment.NPM_CONFIG_USERCONFIG = os.devNull;
  return environment;
}

export interface MacosReleasePaths {
  repository: string;
  versionName: string;
  artifactDirectory: string;
  app: string;
  executable: string;
  plist: string;
  frameworksDirectory: string;
  zip: string;
  unpackDirectory: string;
  unpackedApp: string;
  unpackedExecutable: string;
  unpackedPlist: string;
}

export interface MacosReleaseExecution {
  run(command: MacosReleaseCommand): Promise<string>;
  listFrameworks(directory: string): Promise<string[]>;
  removeFile(file: string): Promise<void>;
  removeTree(directory: string): Promise<void>;
}

export function parseMacosReleaseArguments(arguments_: string[]): {
  tag: string;
  mode: ReleaseMode;
} {
  const rehearsal = arguments_.includes("--rehearsal");
  const positional = arguments_.filter((argument) => argument !== "--rehearsal");
  if (positional.length !== 1) {
    throw new Error("usage: npm run release:macos -- vMAJOR.MINOR.PATCH [--rehearsal]");
  }
  return { tag: positional[0], mode: rehearsal ? "rehearsal" : "release" };
}

export function createMacosReleasePaths(options: {
  repository: string;
  unpackDirectory: string;
  tag: string;
  mode: ReleaseMode;
}): MacosReleasePaths {
  if (!path.isAbsolute(options.repository)) {
    throw new Error("repository path must be absolute");
  }
  if (!path.isAbsolute(options.unpackDirectory)) {
    throw new Error("unpack directory must be absolute");
  }
  const version = parseReleaseTag(options.tag, options.mode);
  const app = path.join(options.repository, "dist/desktop/Kepos.app");
  const unpackedApp = path.join(options.unpackDirectory, "Kepos.app");
  return {
    repository: options.repository,
    versionName: version.versionName,
    artifactDirectory: path.join(options.repository, version.artifactDirectory),
    app,
    executable: path.join(app, "Contents/MacOS/Kepos"),
    plist: path.join(app, "Contents/Info.plist"),
    frameworksDirectory: path.join(app, "Contents/Frameworks"),
    zip: path.join(
      options.repository,
      version.artifactDirectory,
      version.macosArtifactName,
    ),
    unpackDirectory: options.unpackDirectory,
    unpackedApp,
    unpackedExecutable: path.join(unpackedApp, "Contents/MacOS/Kepos"),
    unpackedPlist: path.join(unpackedApp, "Contents/Info.plist"),
  };
}

export function macosSigningCommands(
  paths: MacosReleasePaths,
  frameworks: string[],
): MacosReleaseCommand[] {
  if (frameworks.length === 0) {
    throw new Error("macOS release app has no frameworks to sign");
  }
  for (const framework of frameworks) {
    if (
      path.dirname(framework) !== paths.frameworksDirectory ||
      !path.basename(framework).endsWith(".framework")
    ) {
      throw new Error("macOS release accepts only direct .framework paths");
    }
  }

  const sortedFrameworks = [...frameworks].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const inspectPlist = (
    kind: MacosReleaseCommandKind,
    plist: string,
    key: string,
  ): MacosReleaseCommand => ({
    kind,
    command: "plutil",
    arguments: ["-extract", key, "raw", "-o", "-", plist],
  });
  return [
    {
      kind: "architecture",
      command: "lipo",
      arguments: ["-archs", paths.executable],
    },
    {
      kind: "version-short",
      command: "plutil",
      arguments: [
        "-replace",
        "CFBundleShortVersionString",
        "-string",
        paths.versionName,
        paths.plist,
      ],
    },
    {
      kind: "version-build",
      command: "plutil",
      arguments: [
        "-replace",
        "CFBundleVersion",
        "-string",
        paths.versionName,
        paths.plist,
      ],
    },
    ...sortedFrameworks.map(
      (framework): MacosReleaseCommand => ({
        kind: "sign-framework",
        command: "codesign",
        arguments: ["--force", "--sign", "-", "--timestamp=none", framework],
      }),
    ),
    {
      kind: "sign-app",
      command: "codesign",
      arguments: ["--force", "--sign", "-", "--timestamp=none", paths.app],
    },
    {
      kind: "verify-app",
      command: "codesign",
      arguments: ["--verify", "--deep", "--strict", "--verbose=4", paths.app],
    },
    {
      kind: "inspect-signature",
      command: "codesign",
      arguments: ["-dvvv", paths.app],
    },
    inspectPlist("inspect-version-short", paths.plist, "CFBundleShortVersionString"),
    inspectPlist("inspect-version-build", paths.plist, "CFBundleVersion"),
    {
      kind: "archive",
      command: "ditto",
      arguments: ["-c", "-k", "--keepParent", paths.app, paths.zip],
    },
    {
      kind: "extract",
      command: "ditto",
      arguments: ["-x", "-k", paths.zip, paths.unpackDirectory],
    },
    {
      kind: "verify-archive",
      command: "codesign",
      arguments: [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=4",
        paths.unpackedApp,
      ],
    },
    {
      kind: "inspect-archive-signature",
      command: "codesign",
      arguments: ["-dvvv", paths.unpackedApp],
    },
    inspectPlist(
      "inspect-archive-version-short",
      paths.unpackedPlist,
      "CFBundleShortVersionString",
    ),
    inspectPlist(
      "inspect-archive-version-build",
      paths.unpackedPlist,
      "CFBundleVersion",
    ),
    {
      kind: "inspect-archive-architecture",
      command: "lipo",
      arguments: ["-archs", paths.unpackedExecutable],
    },
  ];
}

export async function releaseMacos(
  options: {
    repository: string;
    unpackDirectory: string;
    tag: string;
    mode: ReleaseMode;
  },
  execution: MacosReleaseExecution,
): Promise<MacosReleasePaths> {
  const paths = createMacosReleasePaths(options);
  try {
    await execution.run({
      kind: "build",
      command: "npm",
      arguments: ["run", "desktop:build"],
    });
    const frameworks = await execution.listFrameworks(paths.frameworksDirectory);
    for (const command of macosSigningCommands(paths, frameworks)) {
      const output = await execution.run(command);
      validateMacosCommandOutput(command.kind, output, paths.versionName);
    }
    await execution.removeTree(paths.unpackDirectory);
    return paths;
  } catch (error) {
    await execution.removeFile(paths.zip).catch(() => undefined);
    await execution.removeTree(paths.unpackDirectory).catch(() => undefined);
    throw error;
  }
}

function validateMacosCommandOutput(
  kind: MacosReleaseCommandKind,
  output: string,
  versionName: string,
): void {
  if (kind === "architecture" || kind === "inspect-archive-architecture") {
    if (output.trim() !== "arm64") {
      throw new Error("macOS release executable must contain only arm64");
    }
    return;
  }
  if (kind === "inspect-signature" || kind === "inspect-archive-signature") {
    if (!output.includes("Signature=adhoc")) {
      throw new Error("macOS release app must have an ad-hoc signature");
    }
    return;
  }
  if (kind.includes("inspect") && kind.includes("version")) {
    if (output.trim() !== versionName) {
      throw new Error(`macOS release version must be ${versionName}`);
    }
  }
}

async function runCommand(
  repository: string,
  command: MacosReleaseCommand,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command.command, command.arguments, {
      cwd: repository,
      env: macosReleaseEnvironment(command.kind, process.env),
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!command.kind.includes("inspect") && command.kind !== "architecture") {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!command.kind.includes("signature")) process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve(output);
      reject(
        new Error(
          `${command.kind} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS release requires an Apple Silicon Mac");
  }
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const { tag, mode } = parseMacosReleaseArguments(process.argv.slice(2));
  await assertReleaseGitState({
    tag,
    mode,
    runGit: (arguments_) =>
      runCommand(repository, {
        kind: "inspect-signature",
        command: "git",
        arguments: arguments_,
      }),
  });
  const version = parseReleaseTag(tag, mode);
  const artifactDirectory = path.join(repository, version.artifactDirectory);
  const zip = path.join(artifactDirectory, version.macosArtifactName);
  await prepareReleaseArtifactDirectory(artifactDirectory, [zip]);
  const unpackDirectory = await mkdtemp(path.join(os.tmpdir(), "kepos-release-macos-"));

  const result = await releaseMacos(
    { repository, unpackDirectory, tag, mode },
    {
      run: (command) => runCommand(repository, command),
      listFrameworks: async (directory) =>
        (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && entry.name.endsWith(".framework"))
          .map((entry) => path.join(directory, entry.name)),
      removeFile: (file) => rm(file, { force: true }),
      removeTree: (directory) => rm(directory, { force: true, recursive: true }),
    },
  );
  process.stdout.write(`macOS ZIP: ${result.zip}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
