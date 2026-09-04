import path from "node:path";

import {
  parsePublisherIdentity,
  serializePublisherIdentity,
  type PublisherIdentity,
} from "../config.js";
import { derivePublisherHomeKey, generatePublisherSeed } from "../keys.js";
import {
  pathExists,
  readStateJson,
  validateStateDirectory,
  writeStateDirectoryAtomically,
} from "./files.js";

const identityFileName = "publisher.json";

export interface SetupPublisherOptions {
  stateDir: string;
}

export interface SetupPublisherResult {
  created: boolean;
  publisherKey: string;
}

export async function getPublisherPublicKey(stateDir: string): Promise<string> {
  const identity = await loadPublisherIdentity(stateDir);
  return derivePublisherHomeKey(identity.seed);
}

/**
 * Create the publisher's stable seed-derived identity when it is absent.
 *
 * Publisher policy intentionally does not live in this directory. The
 * directory is validated as a complete one-file state before an existing
 * identity is reused, so stale manifests, policy snapshots, and partial
 * writes fail closed.
 */
export async function setupPublisher(
  options: SetupPublisherOptions,
): Promise<SetupPublisherResult> {
  const stateDir = path.resolve(options.stateDir);
  if (await pathExists(stateDir)) {
    const identity = await loadPublisherIdentity(stateDir);
    return {
      created: false,
      publisherKey: derivePublisherHomeKey(identity.seed),
    };
  }

  const identity = parsePublisherIdentity({ seed: generatePublisherSeed() });
  await writeStateDirectoryAtomically(
    stateDir,
    new Map([[identityFileName, serializePublisherIdentity(identity)]]),
  );
  return {
    created: true,
    publisherKey: derivePublisherHomeKey(identity.seed),
  };
}

export async function ensurePublisher(
  options: SetupPublisherOptions,
): Promise<SetupPublisherResult> {
  const stateDir = path.resolve(options.stateDir);
  if (!(await pathExists(stateDir))) {
    return setupPublisher({ stateDir });
  }
  const identity = await loadPublisherIdentity(stateDir);
  return {
    created: false,
    publisherKey: derivePublisherHomeKey(identity.seed),
  };
}

export async function loadPublisherIdentity(
  stateDir: string,
): Promise<PublisherIdentity> {
  stateDir = path.resolve(stateDir);
  await validateStateDirectory(stateDir, [identityFileName]);
  return parsePublisherIdentity(
    await readStateJson(path.join(stateDir, identityFileName)),
  );
}
