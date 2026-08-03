import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

export type ReleaseMode = "release" | "rehearsal";

export interface ReleaseVersion {
  tag: string;
  versionName: string;
  androidVersionCode: number;
  artifactDirectory: string;
  androidArtifactName: string;
  macosArtifactName: string;
  checksumName: "SHA256SUMS";
  checksumSignatureName: "SHA256SUMS.minisig";
  mode: ReleaseMode;
}

export type GitRunner = (arguments_: string[]) => Promise<string>;

const releaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const maxAndroidVersionCode = 2_100_000_000n;

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

  const [, majorText, minorText, patchText] = match;
  const major = BigInt(majorText);
  const minor = BigInt(minorText);
  const patch = BigInt(patchText);
  if (minor >= 1_000n || patch >= 1_000n) {
    throw new Error(`invalid release tag components: ${tag}`);
  }

  const androidVersionCode = major * 1_000_000n + minor * 1_000n + patch;
  if (androidVersionCode <= 0n || androidVersionCode > maxAndroidVersionCode) {
    throw new Error(`release tag is outside Android versionCode range: ${tag}`);
  }

  const versionName = `${majorText}.${minorText}.${patchText}`;
  const directoryName = mode === "rehearsal" ? `rehearsal-${tag}` : tag;
  return {
    tag,
    versionName,
    androidVersionCode: Number(androidVersionCode),
    artifactDirectory: `dist/release/${directoryName}`,
    androidArtifactName: `kepos-android-arm64-${tag}.apk`,
    macosArtifactName: `kepos-macos-arm64-${tag}.zip`,
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
  const status = await options.runGit(["status", "--porcelain"]);
  if (status.trim()) throw new Error("release worktree must be clean");
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
}
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
