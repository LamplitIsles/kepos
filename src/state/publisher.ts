import path from "node:path";

import {
  parsePublisherConfig,
  parsePublisherManifest,
  serializePublisherConfig,
  serializePublisherManifest,
  parseSubscriberDevices,
  type SubscriberDevice,
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
  kind?: "tcp" | "http";
  targetPort: number;
  allow?: string[];
}

export interface SetupPublisherOptions {
  stateDir: string;
  displayName: string;
  subscriberDevices: SubscriberDevice[];
  services: PublisherStateService[];
}

export interface SetupPublisherResult {
  created: boolean;
  publisherKey: string;
}

export interface SetPublisherSubscribersOptions {
  stateDir: string;
  subscriberDevices: SubscriberDevice[];
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
  const subscribers = parseSubscriberDevices(options.subscriberDevices);

  if (await pathExists(stateDir)) {
    return readPublisherResult(stateDir, manifest, subscribers, false);
  }

  await writeStateDirectoryAtomically(
    stateDir,
    new Map([
      [manifestFileName, serializePublisherManifest(manifest)],
      [
        configFileName,
        serializePublisherConfig({
          seed: generatePublisherSeed(),
          subscribers,
        }),
      ],
    ]),
  );
  return readPublisherResult(stateDir, manifest, subscribers, true);
}

export async function ensurePublisher(
  options: SetupPublisherOptions,
): Promise<SetupPublisherResult> {
  const stateDir = path.resolve(options.stateDir);
  if (!(await pathExists(stateDir))) {
    return setupPublisher({ ...options, stateDir });
  }

  const { config } = await loadPublisherState(stateDir);
  return {
    created: false,
    publisherKey: derivePublisherHomeKey(config.seed),
  };
}

export async function setPublisherSubscribers(
  options: SetPublisherSubscribersOptions,
): Promise<void> {
  const stateDir = path.resolve(options.stateDir);
  const { config, manifest } = await loadPublisherState(stateDir);
  await writeStateFileAtomically(
    stateDir,
    manifest.publisherConfig,
    serializePublisherConfig({
      seed: config.seed,
      subscribers: parseSubscriberDevices(options.subscriberDevices),
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
        kind: service.kind ?? "tcp",
      }),
    ),
  });
}

async function readPublisherResult(
  stateDir: string,
  expectedManifest: PublisherManifest,
  expectedSubscribers: readonly SubscriberDevice[],
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
  if (JSON.stringify(config.subscribers) !== JSON.stringify(expectedSubscribers)) {
    throw new Error(
      "existing publisher subscriber devices do not match requested subscribers",
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
