/** An invitation is a bearer secret. Never include it in errors or logs. */
export type Invitation = { receiverKey: string; secret: string };

export function parseInvitation(value: string): Invitation {
  const match = /^kepos1:([0-9a-f]{64}):([0-9a-f]{64})$/.exec(value);
  if (!match) throw new Error("unusable invitation");
  return { receiverKey: match[1]!, secret: match[2]! };
}

export function formatInvitation(value: Invitation): string {
  const text = `kepos1:${value.receiverKey}:${value.secret}`;
  parseInvitation(text);
  return text;
}

// Enrollment is carried inside the existing bounded authenticated framing.
export const ENROLLMENT_PREFIX = "Kepos enrollment v1 ";

export function enrollmentRequest(secret: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("unusable invitation");
  return Buffer.from(ENROLLMENT_PREFIX + secret, "ascii");
}

export function enrollmentSecret(frame: Buffer): string | undefined {
  const request = frame.toString("ascii");
  if (!request.startsWith(ENROLLMENT_PREFIX)) return undefined;
  const secret = request.slice(ENROLLMENT_PREFIX.length);
  if (frame.length !== ENROLLMENT_PREFIX.length + 64 || !/^[0-9a-f]{64}$/.test(secret)) throw new Error("unusable invitation");
  return secret;
}
