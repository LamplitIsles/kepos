import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

export type ReleaseMode = "release" | "rehearsal";
export type ReleaseChannel = "stable" | "beta";

export interface ReleaseVersion {
  tag: string;
  channel: ReleaseChannel;
  versionName: string;
  androidVersionCode: number;
  macosShortVersion: string;
  macosBuildVersion: string;
  artifactDirectory: string;
  androidArtifactName: string;
  macosArtifactName: string;
  windowsArtifactName: string;
  checksumName: "SHA256SUMS";
  checksumSignatureName: "SHA256SUMS.minisig";
  mode: ReleaseMode;
}

export type GitRunner = (arguments_: string[]) => Promise<string>;

const releaseTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;
const maxAndroidVersionCode = 2_100_000_000n;
const stableBuildOrdinal = 99n;
const buildOrdinalsPerVersion = 100n;
const releaseSecretVariables = [
  "KEPOS_ANDROID_KEYSTORE",
  "KEPOS_ANDROID_KEY_ALIAS",
  "KEPOS_ANDROID_KEY_PASSWORD",
  "KEPOS_MINISIGN_SECRET_KEY",
] as const;

type ReleaseSecretVariable = (typeof releaseSecretVariables)[number];

export function releaseSubprocessEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  allowedVariables: readonly ReleaseSecretVariable[] = [],
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const variable of releaseSecretVariables) {
    if (!allowedVariables.includes(variable)) delete environment[variable];
  }
  return environment;
}

export async function prepareReleaseArtifactDirectory(
  directory: string,
  expectedOutputs: string[],
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const output of expectedOutputs) {
    if (path.dirname(output) !== directory) {
      throw new Error("release output must be a direct child of its artifact directory");
    }
    try {
      await lstat(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`release output already exists: ${path.basename(output)}`);
  }
}

export function parseReleaseTag(
  tag: string,
  mode: ReleaseMode,
): ReleaseVersion {
  const match = releaseTagPattern.exec(tag);
  if (!match) throw new Error(`invalid release tag: ${JSON.stringify(tag)}`);

  const [, majorText, minorText, patchText, betaText] = match;
  const major = BigInt(majorText);
  const minor = BigInt(minorText);
  const patch = BigInt(patchText);
  if (minor >= 1_000n || patch >= 1_000n) {
    throw new Error(`invalid release tag components: ${tag}`);
  }

  const channel: ReleaseChannel = betaText === undefined ? "stable" : "beta";
  const betaNumber = betaText === undefined ? stableBuildOrdinal : BigInt(betaText);
  if (channel === "beta" && (betaNumber < 1n || betaNumber > 98n)) {
    throw new Error(`invalid beta number in release tag: ${tag}`);
  }

  const base = major * 1_000_000n + minor * 1_000n + patch;
  if (base <= 0n) throw new Error(`invalid release tag components: ${tag}`);
  const androidVersionCode = base * buildOrdinalsPerVersion + betaNumber;
  if (androidVersionCode <= 0n || androidVersionCode > maxAndroidVersionCode) {
    throw new Error(`release tag is outside Android versionCode range: ${tag}`);
  }

  const versionName = `${majorText}.${minorText}.${patchText}${
    betaText === undefined ? "" : `-beta.${betaText}`
  }`;
  const macosShortVersion = `${majorText}.${minorText}.${patchText}`;
  const macosBuildVersion = androidVersionCode.toString();
  const directoryName = mode === "rehearsal" ? `rehearsal-${tag}` : tag;
  return {
    tag,
    channel,
    versionName,
    androidVersionCode: Number(androidVersionCode),
    macosShortVersion,
    macosBuildVersion,
    artifactDirectory: `dist/release/${directoryName}`,
    androidArtifactName: "kepos-android-arm64.apk",
    macosArtifactName: "kepos-macos-arm64.zip",
    windowsArtifactName: "kepos-windows-x64.zip",
    checksumName: "SHA256SUMS",
    checksumSignatureName: "SHA256SUMS.minisig",
    mode,
  };
}

export async function assertReleaseGitState(options: {
  tag: string;
  mode: ReleaseMode;
  runGit: GitRunner;
}): Promise<void> {
  const status = await options.runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.trim()) throw new Error("release worktree must be clean");

  const submoduleStatus = await options.runGit(["submodule", "status", "--recursive"]);
  for (const line of submoduleStatus.split("\n")) {
    if (line && line[0] !== " ") {
      throw new Error(`release submodule is not cleanly checked out: ${line}`);
    }
  }
  try {
    await options.runGit([
      "submodule",
      "foreach",
      "--recursive",
      'test "$(git rev-parse HEAD)" = "$sha1" && test -z "$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)"',
    ]);
  } catch {
    throw new Error("release submodule worktree or gitlink is dirty");
  }

  if (options.mode === "rehearsal") return;

  let exactTag: string;
  try {
    exactTag = await options.runGit([
      "describe",
      "--tags",
      "--exact-match",
      "HEAD",
    ]);
  } catch {
    throw new Error(`release HEAD must have exact tag ${options.tag}`);
  }
  if (exactTag.trim() !== options.tag) {
    throw new Error(`release HEAD must have exact tag ${options.tag}`);
  }

  let tagType: string;
  try {
    tagType = await options.runGit(["cat-file", "-t", `refs/tags/${options.tag}`]);
  } catch {
    throw new Error(`release tag ${options.tag} must be annotated`);
  }
  if (tagType.trim() !== "tag") {
    throw new Error(`release tag ${options.tag} must be annotated`);
  }

  let taggedCommit: string;
  try {
    taggedCommit = await options.runGit(["rev-parse", `${options.tag}^{commit}`]);
  } catch {
    throw new Error(`release tag ${options.tag} does not resolve to a commit`);
  }
  let head: string;
  try {
    head = await options.runGit(["rev-parse", "HEAD"]);
  } catch {
    throw new Error("release HEAD cannot be resolved");
  }
  if (taggedCommit.trim() !== head.trim()) {
    throw new Error(`release tag ${options.tag} does not resolve to HEAD`);
  }
}
