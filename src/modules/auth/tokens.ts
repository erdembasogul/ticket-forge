import { createHash, randomBytes, randomUUID } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function createRefreshToken() {
  const token = randomBytes(32).toString("base64url");
  const familyId = randomUUID();

  return {
    token,
    tokenHash: hashToken(token),
    familyId,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
  }
}