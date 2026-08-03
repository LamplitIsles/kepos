import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  releaseArtifactPaths,
  validateReleaseArtifacts,
  verifyChecksumManifest,
} from "./release-manifest.js";
import {
  assertReleaseGitState,
  releaseSubprocessEnvironment,
  type ReleaseMode,
} from "./release-version.js";

export interface PublishCommand {
  command: "git" | "gh" | "minisign";
  arguments: string[];
  allowFailure: boolean;
}

export interface PublishCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PublishExecution {
  run(command: PublishCommand): Promise<PublishCommandResult>;
}

export function parseRemoteAnnotatedTag(output: string, tag: string): string {
  const directReference = `refs/tags/${tag}`;
  const peeledReference = `${directReference}^{}`;
  const references = new Map<string, string>();
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{40,64})\t(.+)$/.exec(line);
    if (!match) throw new Error("remote tag response has invalid format");
    references.set(match[2], match[1]);
  }
  if (!references.has(directReference) || !references.has(peeledReference)) {
    throw new Error(`remote ${tag} must be an annotated tag`);
  }
  return references.get(peeledReference)!;
}

export async function publishRelease(
  options: {
    repository: string;
    tag: string;
    mode: ReleaseMode;
  },
  execution: PublishExecution,
): Promise<void> {
  if (options.mode === "rehearsal") {
    throw new Error("rehearsal artifacts cannot be published");
  }
  const paths = releaseArtifactPaths(options);
  await validateReleaseArtifacts(paths, "complete");

  const headResult = await execution.run({
    command: "git",
    arguments: ["rev-parse", "HEAD"],
    allowFailure: false,
  });
  requireSuccess(headResult, "git rev-parse HEAD");
  const head = headResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("local HEAD is invalid");

  const remoteResult = await execution.run({
    command: "git",
    arguments: [
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${options.tag}`,
      `refs/tags/${options.tag}^{}`,
    ],
    allowFailure: false,
  });
  requireSuccess(remoteResult, `resolve remote tag ${options.tag}`);
  const remoteCommit = parseRemoteAnnotatedTag(remoteResult.stdout, options.tag);
  if (remoteCommit !== head) {
    throw new Error(`remote tag ${options.tag} does not resolve to local HEAD`);
  }

  const verifyResult = await execution.run({
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
    allowFailure: false,
  });
  requireSuccess(verifyResult, "verify minisign release manifest");
  await verifyChecksumManifest(paths);

  const existing = await execution.run({
    command: "gh",
    arguments: ["release", "view", options.tag, "--json", "tagName"],
    allowFailure: true,
  });
  if (existing.exitCode === 0) {
    throw new Error(`GitHub release already exists for ${options.tag}`);
  }
  if (!/release not found|not found/i.test(existing.stderr)) {
    throw new Error(existing.stderr.trim() || "unable to check existing GitHub release");
  }

  const assets = [paths.apk, paths.zip, paths.manifest, paths.signature];
  const createResult = await execution.run({
    command: "gh",
    arguments: [
      "release",
      "create",
      options.tag,
      "--draft",
      "--verify-tag",
      "--generate-notes",
      ...assets,
    ],
    allowFailure: false,
  });
  requireSuccess(createResult, "create GitHub release draft");
}

function requireSuccess(result: PublishCommandResult, action: string): void {
  if (result.exitCode === 0) return;
  throw new Error(`${action} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

async function runCommand(
  repository: string,
  command: PublishCommand,
): Promise<PublishCommandResult> {
  return new Promise<PublishCommandResult>((resolve, reject) => {
    const child = spawn(command.command, command.arguments, {
      cwd: repository,
      env: releaseSubprocessEnvironment(process.env),
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command.command} failed with signal ${signal}`));
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (!command.allowFailure && result.exitCode !== 0) {
        process.stderr.write(stderr);
      }
      resolve(result);
    });
  });
}

async function main(): Promise<void> {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const [tag, ...extra] = process.argv.slice(2);
  if (!tag || extra.length !== 0) {
    throw new Error("usage: npm run release:draft -- vMAJOR.MINOR.PATCH");
  }
  await assertReleaseGitState({
    tag,
    mode: "release",
    runGit: async (arguments_) => {
      const result = await runCommand(repository, {
        command: "git",
        arguments: arguments_,
        allowFailure: false,
      });
      requireSuccess(result, "verify local release tag");
      return result.stdout;
    },
  });
  await publishRelease(
    { repository, tag, mode: "release" },
    { run: (command) => runCommand(repository, command) },
  );
  process.stdout.write(`GitHub release draft created for ${tag}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
