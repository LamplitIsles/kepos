import {
  createPairingInvitation,
  pairingTokenMatches,
  type CreatePairingInvitationOptions,
} from "./invitation.js";
import type { PairingRequest, PairingResponse } from "./protocol.js";

const publisherKeyPattern = /^[0-9a-f]{64}$/u;

type PairingErrorCode = Extract<
  PairingResponse,
  { status: "error" }
>["code"];

export interface PairingCandidate {
  subscriberKey: string;
  request: PairingRequest;
  approve: () => void;
  deny: () => void;
  fail: (code: PairingErrorCode) => void;
}

export type PublisherPairingSnapshot =
  | { phase: "idle" }
  | { phase: "inviting"; expiresAt: number; expired: boolean }
  | {
      phase: "pending";
      subscriberKey: string;
      keyFingerprint: string;
      label: string;
      platform: string;
    };

export interface PublisherPairingOptions {
  publisherKey: string;
  displayName: string;
  now?: () => number;
  randomBytes?: CreatePairingInvitationOptions["randomBytes"];
  persistSubscriber: (subscriberKey: string) => Promise<void>;
}

interface InvitationState {
  expiresAt: number;
  tokenDigest: Uint8Array;
}

export class PublisherPairing {
  private readonly options: PublisherPairingOptions;
  private readonly now: () => number;
  private invitation?: InvitationState;
  private pending?: PairingCandidate;
  private approving?: Promise<void>;

  constructor(options: PublisherPairingOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  createInvitation(): { uri: string; expiresAt: number } {
    if (this.pending) {
      throw new Error("A pairing request is waiting for approval");
    }
    const issued = createPairingInvitation({
      publisherKey: this.options.publisherKey,
      displayName: this.options.displayName,
      now: this.now,
      randomBytes: this.options.randomBytes,
    });
    this.invitation = {
      expiresAt: issued.expiresAt,
      tokenDigest: issued.tokenDigest,
    };
    return { uri: issued.uri, expiresAt: issued.expiresAt };
  }

  receive(candidate: PairingCandidate): boolean {
    if (this.pending) {
      candidate.fail("invitation-unavailable");
      return false;
    }
    const invitation = this.invitation;
    if (!invitation || invitation.expiresAt <= this.now()) {
      this.invitation = undefined;
      candidate.fail("invitation-unavailable");
      return false;
    }
    if (
      !publisherKeyPattern.test(candidate.subscriberKey) ||
      !pairingTokenMatches(candidate.request.token, invitation.tokenDigest)
    ) {
      candidate.fail("invalid-request");
      return false;
    }
    this.invitation = undefined;
    this.pending = candidate;
    return true;
  }

  snapshot(): PublisherPairingSnapshot {
    if (this.pending) {
      return {
        phase: "pending",
        subscriberKey: this.pending.subscriberKey,
        keyFingerprint: this.pending.subscriberKey.slice(0, 16),
        label: this.pending.request.label,
        platform: this.pending.request.platform,
      };
    }
    if (this.invitation) {
      return {
        phase: "inviting",
        expiresAt: this.invitation.expiresAt,
        expired: this.invitation.expiresAt <= this.now(),
      };
    }
    return { phase: "idle" };
  }

  async approve(): Promise<void> {
    if (!this.pending) throw new Error("No pairing request is pending");
    if (this.approving) return this.approving;
    const pending = this.pending;
    const operation = (async () => {
      await this.options.persistSubscriber(pending.subscriberKey);
      if (this.pending !== pending) {
        throw new Error("Pairing request changed during approval");
      }
      pending.approve();
      this.pending = undefined;
    })();
    this.approving = operation;
    try {
      await operation;
    } finally {
      if (this.approving === operation) this.approving = undefined;
    }
  }

  deny(): void {
    if (this.approving) {
      throw new Error("Pairing approval is already being persisted");
    }
    this.pending?.deny();
    this.pending = undefined;
    this.invitation = undefined;
  }

  cancel(): void {
    this.deny();
  }

  waitForApproval(): Promise<void> {
    return this.approving ?? Promise.resolve();
  }

  acceptsCandidates(): boolean {
    return (
      this.pending === undefined &&
      this.invitation !== undefined &&
      this.invitation.expiresAt > this.now()
    );
  }
}
