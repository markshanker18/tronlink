// Signed QR payload system — prevents tampered or replayed QR codes.
// Uses HMAC-SHA256 over a canonical JSON payload.
// Requires QR_SIGNING_SECRET environment variable.

import { createHmac, randomBytes } from "node:crypto";
import type { Plan } from "../shared/schema";

const QR_PAYLOAD_VERSION = 1;
const QR_PAYLOAD_TTL_HOURS = Math.max(
  1,
  Number.parseInt(process.env.QR_PAYLOAD_TTL_HOURS || "168", 10) // default 7 days
);

export interface QrPayload {
  v: typeof QR_PAYLOAD_VERSION;
  planId: string;
  planVersion: number;
  planCode: string;
  nonce: string;       // 32 random bytes hex — stored in qr_nonces table on first use
  issuedAt: number;    // Unix seconds
  expiresAt: number;   // Unix seconds
  sig: string;         // HMAC-SHA256 hex of all other fields (sorted canonical JSON)
}

function getSigningKey(): Buffer {
  const secret = process.env.QR_SIGNING_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CRITICAL: QR_SIGNING_SECRET environment variable is missing. This is required for secure QR generation in production. Please set this in your environment configuration.");
    }
    // Non-production fallback — derived from SESSION_SECRET for convenience
    const fallback = process.env.SESSION_SECRET || "dev-qr-signing-insecure";
    return Buffer.from(fallback + "-qr-payload-v1");
  }
  return Buffer.from(secret);
}

function computeSig(fields: Omit<QrPayload, "sig">): string {
  // Sort keys for deterministic canonical JSON
  const sorted = Object.fromEntries(
    Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))
  );
  const canonical = JSON.stringify(sorted);
  return createHmac("sha256", getSigningKey()).update(canonical).digest("hex");
}

export function signQrPayload(plan: Plan): QrPayload {
  const nonce = randomBytes(32).toString("hex");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + QR_PAYLOAD_TTL_HOURS * 3600;

  const fields: Omit<QrPayload, "sig"> = {
    v: QR_PAYLOAD_VERSION,
    planId: plan.id,
    planVersion: plan.planVersion ?? 1,
    planCode: plan.planCode,
    nonce,
    issuedAt,
    expiresAt,
  };

  const sig = computeSig(fields);
  return { ...fields, sig };
}

/**
 * Verify a signed QR payload.
 * Throws a descriptive error if invalid.
 * Does NOT check nonce uniqueness — that is done by the route handler after recording the nonce.
 */
export function verifyQrPayloadSignature(payload: QrPayload): void {
  const { sig, ...fields } = payload;

  // Verify signature
  const expectedSig = computeSig(fields as Omit<QrPayload, "sig">);
  if (sig !== expectedSig) {
    throw new Error("Invalid QR signature");
  }

  // Check expiry
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.expiresAt < nowSec) {
    throw new Error("QR payload has expired");
  }

  // Check version
  if (payload.v !== QR_PAYLOAD_VERSION) {
    throw new Error(`Unsupported QR payload version: ${payload.v}`);
  }
}

/**
 * Full verification including nonce replay check.
 * Requires storage import — called from route handler.
 */
export async function verifyQrPayload(
  payload: QrPayload,
  recordNonce: (nonce: string, planId: string, expiresAt: Date) => Promise<void>,
  isNonceUsed: (nonce: string) => Promise<boolean>
): Promise<void> {
  verifyQrPayloadSignature(payload);

  // Check nonce replay
  if (await isNonceUsed(payload.nonce)) {
    throw new Error("QR nonce already used — scan the QR code again to generate a fresh link");
  }

  // Record nonce on first use
  await recordNonce(payload.nonce, payload.planId, new Date(payload.expiresAt * 1000));
}
