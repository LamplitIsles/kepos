import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reportAndroidApkSizes } from "./report-android-size.js";
import {
  assertReleaseGitState,
  parseReleaseTag,
  type ReleaseMode,
} from "./release-version.js";

export type AndroidReleaseCommandKind =
  | "fetch"
  | "bundle"
  | "build"
  | "zipalign"
  | "sign"
  | "verify";

export interface AndroidReleaseCommand {
  kind: AndroidReleaseCommandKind;
  command: string;
  arguments: string[];
  environment?: Record<string, string>;
}

export interface AndroidReleasePlan {
  repository: string;
  expectedFingerprint: string;
  finalApk: string;
  alignedApk: string;
  debugApk: string;
  artifactDirectory: string;
  commands: AndroidReleaseCommand[];
}

export interface AndroidReleaseExecution {
  run(command: AndroidReleaseCommand): Promise<string>;
  remove(file: string): Promise<void>;
  reportSizes(repository: string, releaseApk: string): Promise<string>;
}

export function androidReleaseEnvironment(
  kind: AndroidReleaseCommandKind,
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  delete environment.KEPOS_ANDROID_KEYSTORE;
  delete environment.KEPOS_ANDROID_KEY_ALIAS;
  if (kind !== "sign") delete environment.KEPOS_ANDROID_KEY_PASSWORD;
  return environment;
}

export function createAndroidReleasePlan(options: {
  repository: string;
  androidHome: string;
  keystore: string;
  keyAlias: string;
  keyPassword: string;
  expectedFingerprint: string;
  tag: string;
  mode: ReleaseMode;
}): AndroidReleasePlan {
  if (!path.isAbsolute(options.repository)) {
    throw new Error("repository path must be absolute");
  }
  if (!path.isAbsolute(options.androidHome)) {
    throw new Error("ANDROID_HOME must be an absolute path");
  }
  if (!path.isAbsolute(options.keystore)) {
    throw new Error("Android keystore must be an absolute path");
  }
  if (isInside(options.repository, options.keystore)) {
    throw new Error("Android keystore must be outside the repository");
  }
  if (!options.keyAlias.trim()) throw new Error("Android key alias is required");
  if (!options.keyPassword) throw new Error("Android key password is required");
  if (!/^[0-9a-f]{64}$/.test(options.expectedFingerprint)) {
    throw new Error("Android certificate fingerprint must be 64 lowercase hex characters");
  }

  const version = parseReleaseTag(options.tag, options.mode);
  const artifactDirectory = path.join(
    options.repository,
    version.artifactDirectory,
  );
  const finalApk = path.join(artifactDirectory, version.androidArtifactName);
  const alignedApk = path.join(
    artifactDirectory,
    `.${version.androidArtifactName}.aligned`,
  );
  const debugApk = path.join(
    options.repository,
    "android/app/build/outputs/apk/debug/app-debug.apk",
  );
  const unsignedApk = path.join(
    options.repository,
    "android/app/build/outputs/apk/release/app-release-unsigned.apk",
  );
  const buildTools = path.join(options.androidHome, "build-tools", "35.0.0");
  const apksigner = path.join(buildTools, "apksigner");

  return {
    repository: options.repository,
    expectedFingerprint: options.expectedFingerprint,
    finalApk,
    alignedApk,
    debugApk,
    artifactDirectory,
    commands: [
      {
        kind: "fetch",
        command: "npm",
        arguments: ["run", "android:fetch-bare-kit"],
      },
      {
        kind: "bundle",
        command: "npm",
        arguments: ["run", "android:bundle"],
      },
      {
        kind: "build",
        command: path.join(options.repository, "android", "gradlew"),
        arguments: [
          "-p",
          "android",
          "assembleDebug",
          "assembleRelease",
          `-PkeposVersionName=${version.versionName}`,
          `-PkeposVersionCode=${version.androidVersionCode}`,
        ],
      },
      {
        kind: "zipalign",
        command: path.join(buildTools, "zipalign"),
        arguments: ["-f", "-P", "16", "4", unsignedApk, alignedApk],
      },
      {
        kind: "sign",
        command: apksigner,
        arguments: [
          "sign",
          "--ks",
          options.keystore,
          "--ks-key-alias",
          options.keyAlias,
          "--ks-pass",
          "env:KEPOS_ANDROID_KEY_PASSWORD",
          "--key-pass",
          "env:KEPOS_ANDROID_KEY_PASSWORD",
          "--out",
          finalApk,
          alignedApk,
        ],
      },
      {
        kind: "verify",
        command: apksigner,
        arguments: ["verify", "--verbose", "--print-certs", finalApk],
        environment: { LC_ALL: "C" },
      },
    ],
  };
}

export function normalizeCertificateFingerprint(output: string): string {
  const match = /certificate SHA-256 digest:\s*([0-9a-f:]+)/i.exec(output);
  if (!match) throw new Error("apksigner output is missing certificate SHA-256 digest");
  const fingerprint = match[1].replaceAll(":", "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("apksigner returned an invalid certificate SHA-256 digest");
  }
  return fingerprint;
}

export async function executeAndroidRelease(
  plan: AndroidReleasePlan,
  execution: AndroidReleaseExecution,
): Promise<string> {
  try {
    let verificationOutput = "";
    for (const command of plan.commands) {
      const output = await execution.run(command);
      if (command.kind === "verify") verificationOutput = output;
    }
    const actualFingerprint = normalizeCertificateFingerprint(verificationOutput);
    if (actualFingerprint !== plan.expectedFingerprint) {
      throw new Error("Android certificate fingerprint does not match committed identity");
    }
    const report = await execution.reportSizes(plan.repository, plan.finalApk);
    await execution.remove(plan.alignedApk);
    return report;
  } catch (error) {
    await execution.remove(plan.finalApk).catch(() => undefined);
    await execution.remove(plan.alignedApk).catch(() => undefined);
    throw error;
  }
}

function isInside(repository: string, candidate: string): boolean {
  const relative = path.relative(repository, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function runCommand(
  repository: string,
  command: AndroidReleaseCommand,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command.command, command.arguments, {
      cwd: repository,
      env: {
        ...androidReleaseEnvironment(command.kind, process.env),
        ...command.environment,
      },
      stdio: ["inherit", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (command.kind !== "verify") process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
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
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const { tag, mode } = parseAndroidReleaseArguments(process.argv.slice(2));
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!androidHome) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT is required");

  const keystore = process.env.KEPOS_ANDROID_KEYSTORE ?? "";
  const keyAlias = process.env.KEPOS_ANDROID_KEY_ALIAS ?? "";
  const keyPassword = process.env.KEPOS_ANDROID_KEY_PASSWORD ?? "";
  const fingerprintFile = path.join(repository, "release/android-certificate.sha256");
  const fingerprintText = await readFile(fingerprintFile, "utf8");
  if (!/^[0-9a-f]{64}\n$/.test(fingerprintText)) {
    throw new Error("release/android-certificate.sha256 has invalid format");
  }

  await assertReleaseGitState({
    tag,
    mode,
    runGit: async (arguments_) =>
      runCommand(repository, {
        kind: "verify",
        command: "git",
        arguments: arguments_,
      }),
  });
  const plan = createAndroidReleasePlan({
    repository,
    androidHome,
    keystore,
    keyAlias,
    keyPassword,
    expectedFingerprint: fingerprintText.trim(),
    tag,
    mode,
  });
  await verifyAndroidInputs(plan, keystore);
  await mkdir(path.dirname(plan.artifactDirectory), { recursive: true });
  await mkdir(plan.artifactDirectory);

  const report = await executeAndroidRelease(plan, {
    run: (command) => runCommand(repository, command),
    remove: (file) => rm(file, { force: true }),
    reportSizes: reportAndroidApkSizes,
  });
  process.stdout.write(`${report}\nSigned APK: ${plan.finalApk}\n`);
}

export function parseAndroidReleaseArguments(arguments_: string[]): {
  tag: string;
  mode: ReleaseMode;
} {
  const rehearsal = arguments_.includes("--rehearsal");
  const positional = arguments_.filter((argument) => argument !== "--rehearsal");
  if (positional.length !== 1) {
    throw new Error("usage: npm run release:android -- vMAJOR.MINOR.PATCH [--rehearsal]");
  }
  return { tag: positional[0], mode: rehearsal ? "rehearsal" : "release" };
}

async function verifyAndroidInputs(
  plan: AndroidReleasePlan,
  keystore: string,
): Promise<void> {
  const executableCommands = plan.commands.filter(({ kind }) =>
    ["build", "zipalign", "sign"].includes(kind),
  );
  await Promise.all([
    stat(keystore).then((value) => {
      if (!value.isFile()) throw new Error("Android keystore is not a file");
    }),
    ...executableCommands.map(({ command }) => access(command, constants.X_OK)),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
