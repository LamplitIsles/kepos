import path from "node:path";

import {
  parsePublisherConfig,
  parsePublisherManifest,
  serializePublisherConfig,
  serializePublisherManifest,
  type PublisherManifest,
  type PublisherService,
} from "../config.js";
import { derivePublisherHomeKey, generatePublisherSeed } from "../keys.js";
import {
  pathExists,
  readStateJson,
  validateStateDirectory,
  writeStateDirectoryAtomically,
  writeStateFileAtomically,
} from "./files.js";

const manifestFileName = "publisher.manifest.json";
const configFileName = "publisher.json";

export interface PublisherStateService {
  id: string;
  name: string;
  targetPort: number;
  allow?: string[];
}

export interface SetupPublisherOptions {
  stateDir: string;
  displayName: string;
  subscriberPublicKeys: string[];
  services: PublisherStateService[];
}

export interface SetupPublisherResult {
  created: boolean;
  publisherKey: string;
}

export interface SetPublisherAllowlistOptions {
  stateDir: string;
  subscriberPublicKeys: string[];
}

export interface SetPublisherServicesOptions {
  stateDir: string;
  services: PublisherStateService[];
}

export async function getPublisherPublicKey(stateDir: string): Promise<string> {
  const { config } = await loadPublisherState(stateDir);
  return derivePublisherHomeKey(config.seed);
}

export async function setupPublisher(
  options: SetupPublisherOptions,
): Promise<SetupPublisherResult> {
  const stateDir = path.resolve(options.stateDir);
  const manifest = createManifest(options.displayName, options.services);
  const allow = parseAllowlist(options.subscriberPublicKeys);

  if (await pathExists(stateDir)) {
    return readPublisherResult(stateDir, manifest, allow, false);
  }

  await writeStateDirectoryAtomically(
    stateDir,
    new Map([
      [manifestFileName, serializePublisherManifest(manifest)],
      [
        configFileName,
        serializePublisherConfig({
          seed: generatePublisherSeed(),
          allow,
        }),
      ],
    ]),
  );
  return readPublisherResult(stateDir, manifest, allow, true);
}

export async function setPublisherAllowlist(
  options: SetPublisherAllowlistOptions,
): Promise<void> {
  const stateDir = path.resolve(options.stateDir);
  const { config, manifest } = await loadPublisherState(stateDir);
  await writeStateFileAtomically(
    stateDir,
    manifest.publisherConfig,
    serializePublisherConfig({
      seed: config.seed,
      allow: parseAllowlist(options.subscriberPublicKeys),
    }),
  );
  await validatePublisherState(stateDir, manifest);
}

export async function setPublisherServices(
  options: SetPublisherServicesOptions,
): Promise<void> {
  const stateDir = path.resolve(options.stateDir);
  const { manifest } = await loadPublisherState(stateDir);
  const nextManifest = createManifest(
    manifest.displayName,
    options.services,
  );
  await writeStateFileAtomically(
    stateDir,
    manifestFileName,
    serializePublisherManifest(nextManifest),
  );
  await validatePublisherState(stateDir, nextManifest);
}

function createManifest(
  displayName: string,
  services: PublisherStateService[],
): PublisherManifest {
  return parsePublisherManifest({
    displayName,
    publisherConfig: configFileName,
    services: services.map(
      (service): PublisherService => ({
        ...service,
        kind: "tcp",
      }),
    ),
  });
}

function parseAllowlist(subscriberPublicKeys: string[]): string[] {
  return parsePublisherConfig({
    seed: "00".repeat(32),
    allow: subscriberPublicKeys,
  }).allow;
}

async function readPublisherResult(
  stateDir: string,
  expectedManifest: PublisherManifest,
  expectedAllow: readonly string[],
  created: boolean,
): Promise<SetupPublisherResult> {
  const { config, manifest } = await loadPublisherState(stateDir);
  if (
    serializePublisherManifest(manifest) !==
    serializePublisherManifest(expectedManifest)
  ) {
    throw new Error(
      "existing publisher manifest does not match requested topology",
    );
  }
  if (
    config.allow.length !== expectedAllow.length ||
    config.allow.some((key, index) => key !== expectedAllow[index])
  ) {
    throw new Error(
      "existing publisher allowlist does not match requested subscribers",
    );
  }
  return {
    created,
    publisherKey: derivePublisherHomeKey(config.seed),
  };
}

export async function loadPublisherState(stateDir: string) {
  stateDir = path.resolve(stateDir);
  const manifest = parsePublisherManifest(
    await readStateJson(path.join(stateDir, manifestFileName)),
  );
  await validatePublisherState(stateDir, manifest);
  const config = parsePublisherConfig(
    await readStateJson(path.join(stateDir, manifest.publisherConfig)),
  );
  return { config, manifest };
}

async function validatePublisherState(
  stateDir: string,
  manifest: PublisherManifest,
): Promise<void> {
  await validateStateDirectory(stateDir, [
    manifestFileName,
    manifest.publisherConfig,
  ]);
}
