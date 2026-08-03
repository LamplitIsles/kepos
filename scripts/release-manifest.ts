import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReleaseGitState,
  parseReleaseTag,
  prepareReleaseArtifactDirectory,
  releaseSubprocessEnvironment,
  type ReleaseMode,
  type ReleaseVersion,
} from "./release-version.js";

export interface ReleaseArtifactPaths {
  version: ReleaseVersion;
  repository: string;
  directory: string;
  apk: string;
  zip: string;
  manifest: string;
  signature: string;
  publicKey: string;
}

export interface ManifestCommand {
  command: "minisign";
  arguments: string[];
}

export function parseManifestReleaseArguments(arguments_: string[]): {
  tag: string;
  mode: ReleaseMode;
} {
  const rehearsal = arguments_.includes("--rehearsal");
  const positional = arguments_.filter((argument) => argument !== "--rehearsal");
  if (positional.length !== 1) {
    throw new Error("usage: npm run release:manifest -- vMAJOR.MINOR.PATCH [--rehearsal]");
  }
  return { tag: positional[0], mode: rehearsal ? "rehearsal" : "release" };
}

export function releaseArtifactPaths(options: {
  repository: string;
  tag: string;
  mode: ReleaseMode;
}): ReleaseArtifactPaths {
  if (!path.isAbsolute(options.repository)) {
    throw new Error("repository path must be absolute");
  }
  const version = parseReleaseTag(options.tag, options.mode);
  const directory = path.join(options.repository, version.artifactDirectory);
  return {
    version,
    repository: options.repository,
    directory,
    apk: path.join(directory, version.androidArtifactName),
    zip: path.join(directory, version.macosArtifactName),
    manifest: path.join(directory, version.checksumName),
    signature: path.join(directory, version.checksumSignatureName),
    publicKey: path.join(options.repository, "release/minisign.pub"),
  };
}

export async function validateReleaseArtifacts(
  paths: ReleaseArtifactPaths,
  phase: "source" | "complete",
): Promise<void> {
  const expected =
    phase === "source"
      ? [paths.apk, paths.zip]
      : [paths.apk, paths.zip, paths.manifest, paths.signature];
  let entries: string[];
  try {
    entries = await readdir(paths.directory);
  } catch {
    throw new Error("release artifact directory is missing");
  }
  const expectedNames = expected.map((file) => path.basename(file)).sort();
  if (entries.sort().join("\n") !== expectedNames.join("\n")) {
    throw new Error("release artifact directory contains missing or extra artifacts");
  }
  for (const file of expected) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`release artifact must be a non-empty regular file: ${path.basename(file)}`);
    }
  }
}

export async function createReleaseManifest(
  options: {
    repository: string;
    tag: string;
    mode: ReleaseMode;
    secretKey: string;
  },
  execution: { run(command: ManifestCommand): Promise<void> },
): Promise<ReleaseArtifactPaths> {
  if (!path.isAbsolute(options.secretKey)) {
    throw new Error("minisign secret key must be an absolute path");
  }
  if (isInside(options.repository, options.secretKey)) {
    throw new Error("minisign secret key must be outside the repository");
  }
  const paths = releaseArtifactPaths(options);
  await validateReleaseArtifacts(paths, "source");
  await prepareReleaseArtifactDirectory(paths.directory, [
    paths.manifest,
    paths.signature,
  ]);

  try {
    const artifacts = [paths.apk, paths.zip].sort((left, right) =>
      path.basename(left).localeCompare(path.basename(right), "en"),
    );
    const checksums = await Promise.all(
      artifacts.map(async (file) => `${await sha256(file)}  ${path.basename(file)}\n`),
    );
    await writeFile(paths.manifest, checksums.join(""), {
      encoding: "utf8",
      flag: "wx",
    });
    await execution.run({
      command: "minisign",
      arguments: [
        "-S",
        "-s",
        options.secretKey,
        "-m",
        paths.manifest,
        "-x",
        paths.signature,
      ],
    });
    const signature = await lstat(paths.signature);
    if (!signature.isFile() || signature.size === 0) {
      throw new Error("minisign signature artifact is missing or empty");
    }
    await execution.run({
      command: "minisign",
      arguments: [
        "-V",
        "-m",
        paths.manifest,
        "-x",
        paths.signature,
        "-p",
        paths.publicKey,
      ],
    });
    await verifyChecksumManifest(paths);
    await validateReleaseArtifacts(paths, "complete");
    return paths;
  } catch (error) {
    await rm(paths.manifest, { force: true }).catch(() => undefined);
    await rm(paths.signature, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function verifyChecksumManifest(
  paths: ReleaseArtifactPaths,
): Promise<void> {
  const manifest = await readFile(paths.manifest, "utf8");
  const expected = new Map([
    [path.basename(paths.apk), paths.apk],
    [path.basename(paths.zip), paths.zip],
  ]);
  const lines = manifest.trimEnd().split("\n");
  if (lines.length !== expected.size) {
    throw new Error("SHA256SUMS must cover exactly the APK and ZIP");
  }
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^/]+)$/.exec(line);
    if (!match) throw new Error("SHA256SUMS has invalid format");
    const [, digest, name] = match;
    const file = expected.get(name);
    if (!file) throw new Error(`SHA256SUMS contains unexpected artifact: ${name}`);
    if ((await sha256(file)) !== digest) {
      throw new Error(`SHA256SUMS mismatch for ${name}`);
    }
    expected.delete(name);
  }
  if (expected.size !== 0) throw new Error("SHA256SUMS is missing an artifact");
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isInside(repository: string, candidate: string): boolean {
  const relative = path.relative(repository, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function runCommand(command: ManifestCommand): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.arguments, {
      env: releaseSubprocessEnvironment(process.env),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `minisign failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const { tag, mode } = parseManifestReleaseArguments(process.argv.slice(2));
  const secretKey = process.env.KEPOS_MINISIGN_SECRET_KEY ?? "";
  if (!path.isAbsolute(secretKey)) {
    throw new Error("KEPOS_MINISIGN_SECRET_KEY must be an absolute path outside the repository");
  }
  const secretMetadata = await stat(secretKey);
  if (!secretMetadata.isFile()) throw new Error("minisign secret key is not a file");
  const subprocessEnvironment = releaseSubprocessEnvironment(process.env);
  const minisignVersion = spawnSync("minisign", ["-v"], {
    encoding: "utf8",
    env: subprocessEnvironment,
  });
  if (minisignVersion.status !== 0) {
    throw new Error("minisign is required on the release Mac");
  }
  await assertReleaseGitState({
    tag,
    mode,
    runGit: async (arguments_) => {
      const result = spawnSync("git", arguments_, {
        cwd: repository,
        encoding: "utf8",
        env: subprocessEnvironment,
      });
      if (result.status !== 0) throw new Error(result.stderr || "git failed");
      return result.stdout;
    },
  });
  const result = await createReleaseManifest(
    { repository, tag, mode, secretKey },
    { run: runCommand },
  );
  process.stdout.write(`Manifest: ${result.manifest}\nSignature: ${result.signature}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
