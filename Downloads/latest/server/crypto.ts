import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const LEGACY_SALT = "cryptopay-salt";
const V2_INFO = "cryptopay-executor-key-v2";
let fallbackWarningLogged = false;

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is required for encryption operations");
  }
  return secret;
}

function parseMasterKeyFromEnv(): Buffer | null {
  const raw = process.env.ENCRYPTION_MASTER_KEY;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Accept quoted env values from dashboards/shells.
  const normalized = (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) ? trimmed.slice(1, -1).trim() : trimmed;

  if (!normalized) return null;

  // 64-char hex (with optional 0x prefix)
  const hex = normalized.toLowerCase().startsWith("0x") ? normalized.slice(2) : normalized;
  if (/^[a-fA-F0-9]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }

  // base64/base64url (32 bytes expected)
  const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const paddedBase64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const asBase64 = Buffer.from(paddedBase64, "base64");
  if (asBase64.length === 32) {
    return asBase64;
  }

  throw new Error("ENCRYPTION_MASTER_KEY must be 32 bytes (base64/base64url or 64-char hex, optional 0x prefix)");
}

function getLegacyKey(): Buffer {
  return scryptSync(getSessionSecret(), LEGACY_SALT, 32);
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

function deriveV2KeyWithMaster(master: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, salt, Buffer.from(V2_INFO), 32));
}

function deriveV2KeyWithSessionSecret(salt: Buffer, warn: boolean): Buffer {
  if (warn && !fallbackWarningLogged) {
    fallbackWarningLogged = true;
    console.warn("[crypto] ENCRYPTION_MASTER_KEY is not set. Falling back to SESSION_SECRET-derived encryption key.");
  }
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(getSessionSecret(), "utf8"), salt, Buffer.from(V2_INFO), 32)
  );
}

function getV2KeyForEncryption(salt: Buffer): Buffer {
  const master = parseMasterKeyFromEnv();
  if (master) {
    return deriveV2KeyWithMaster(master, salt);
  }

  if (isProductionRuntime()) {
    throw new Error("ENCRYPTION_MASTER_KEY is required in production to encrypt executor private keys");
  }

  // Development fallback keeps local workflows working without breaking existing environments.
  return deriveV2KeyWithSessionSecret(salt, true);
}

function getV2DecryptionCandidates(salt: Buffer): Buffer[] {
  const candidates: Buffer[] = [];
  const master = parseMasterKeyFromEnv();
  if (master) {
    candidates.push(deriveV2KeyWithMaster(master, salt));
  }
  candidates.push(deriveV2KeyWithSessionSecret(salt, false));
  return candidates;
}

function decryptWithKey(iv: Buffer, authTag: Buffer, encrypted: string, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function encrypt(text: string): string {
  const salt = randomBytes(16);
  const key = getV2KeyForEncryption(salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `v2:${salt.toString("hex")}:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(":");

  if (parts[0] === "v2") {
    const [, saltHex, ivHex, authTagHex, encrypted] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    let lastErr: unknown = null;
    for (const key of getV2DecryptionCandidates(salt)) {
      try {
        return decryptWithKey(iv, authTag, encrypted, key);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Unable to decrypt value");
  }

  // Legacy format: iv:authTag:ciphertext
  const [ivHex, authTagHex, encrypted] = parts;
  const key = getLegacyKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
