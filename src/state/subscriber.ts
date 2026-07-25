import path from "node:path";
import { rename, rm } from "node:fs/promises";

import {
  parseSubscriberContact,
  serializeSubscriberContact,
  type SubscriberContact,
} from "../config.js";
import {
  generateClientIdentity,
  parseClientIdentity,
  serializeClientIdentity,
  type ClientIdentity,
} from "../keys.js";
import {
  pathExists,
  readStateJson,
  validateStateDirectory,
  writeStateDirectoryAtomically,
  writeStateFileAtomically,
} from "./files.js";

const identityFileName = "client.identity.json";
const contactFileName = "publisher.contact.json";
const pendingContactFileName = "publisher.pending.json";

export interface SetupSubscriberOptions {
  stateDir: string;
}

export interface SetupSubscriberResult {
  created: boolean;
  configured: boolean;
  publicKey: string;
}

export interface SetSubscriberPublisherOptions {
  stateDir: string;
  label: string;
  publisherKey: string;
}

export interface SubscriberState {
  identity: ClientIdentity;
  contact: SubscriberContact;
}

export interface SubscriberConnectionState extends SubscriberState {
  pending: boolean;
}

export async function setupSubscriber(
  options: SetupSubscriberOptions,
): Promise<SetupSubscriberResult> {
  const stateDir = path.resolve(options.stateDir);
  if (await pathExists(stateDir)) {
    const identity = await readSubscriberIdentity(stateDir);
    return {
      created: false,
      configured:
        (await pathExists(path.join(stateDir, contactFileName))) ||
        (await pathExists(path.join(stateDir, pendingContactFileName))),
      publicKey: identity.publicKey,
    };
  }

  const identity = generateClientIdentity();
  await writeStateDirectoryAtomically(
    stateDir,
    new Map([[identityFileName, serializeClientIdentity(identity)]]),
  );
  return { created: true, configured: false, publicKey: identity.publicKey };
}

export async function setSubscriberPublisher(
  options: SetSubscriberPublisherOptions,
): Promise<string> {
  const stateDir = path.resolve(options.stateDir);
  await readSubscriberIdentity(stateDir);
  const contact = parseSubscriberContact({
    publisherKey: options.publisherKey,
    label: options.label,
    requestedLocalPort: 0,
  });
  await rm(path.join(stateDir, pendingContactFileName), { force: true });
  const contactPath = await writeStateFileAtomically(
    stateDir,
    contactFileName,
    serializeSubscriberContact(contact),
  );
  await validateStateDirectory(stateDir, [
    identityFileName,
    contactFileName,
  ]);
  return contactPath;
}

export async function setSubscriberPendingPublisher(
  options: SetSubscriberPublisherOptions,
): Promise<string> {
  const stateDir = path.resolve(options.stateDir);
  await readSubscriberIdentity(stateDir);
  if (await pathExists(path.join(stateDir, contactFileName))) {
    throw new Error("Subscriber already has an approved publisher");
  }
  const contact = parseSubscriberContact({
    publisherKey: options.publisherKey,
    label: options.label,
    requestedLocalPort: 0,
  });
  const contactPath = await writeStateFileAtomically(
    stateDir,
    pendingContactFileName,
    serializeSubscriberContact(contact),
  );
  await validateStateDirectory(stateDir, [
    identityFileName,
    pendingContactFileName,
  ]);
  return contactPath;
}

export async function promoteSubscriberPendingPublisher(
  stateDir: string,
): Promise<void> {
  stateDir = path.resolve(stateDir);
  await validateStateDirectory(stateDir, [
    identityFileName,
    pendingContactFileName,
  ]);
  await rename(
    path.join(stateDir, pendingContactFileName),
    path.join(stateDir, contactFileName),
  );
  await validateStateDirectory(stateDir, [identityFileName, contactFileName]);
}

export async function loadSubscriberState(
  stateDir: string,
): Promise<SubscriberState> {
  const state = await loadSubscriberConnectionState(stateDir);
  if (state.pending) {
    throw new Error("Subscriber publisher is still pending approval");
  }
  return { identity: state.identity, contact: state.contact };
}

export async function loadSubscriberConnectionState(
  stateDir: string,
): Promise<SubscriberConnectionState> {
  stateDir = path.resolve(stateDir);
  const hasContact = await pathExists(path.join(stateDir, contactFileName));
  const hasPending = await pathExists(
    path.join(stateDir, pendingContactFileName),
  );
  if (hasContact === hasPending) {
    throw new Error("Subscriber must have one active or pending publisher");
  }
  const selectedContact = hasContact ? contactFileName : pendingContactFileName;
  await validateStateDirectory(stateDir, [identityFileName, selectedContact]);
  return {
    identity: parseClientIdentity(
      await readStateJson(path.join(stateDir, identityFileName)),
    ),
    contact: parseSubscriberContact(
      await readStateJson(path.join(stateDir, selectedContact)),
    ),
    pending: hasPending,
  };
}

async function readSubscriberIdentity(stateDir: string) {
  const hasContact = await pathExists(path.join(stateDir, contactFileName));
  const hasPending = await pathExists(
    path.join(stateDir, pendingContactFileName),
  );
  const names = hasContact
    ? [identityFileName, contactFileName]
    : hasPending
      ? [identityFileName, pendingContactFileName]
      : [identityFileName];
  await validateStateDirectory(stateDir, names);
  return parseClientIdentity(
    await readStateJson(path.join(stateDir, identityFileName)),
  );
}
