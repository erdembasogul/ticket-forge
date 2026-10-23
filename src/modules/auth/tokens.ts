import { createHash, randomBytes, randomUUID } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function createRefreshToken(familyId: string = randomUUID()) {
  const token = randomBytes(32).toString("base64url");

  return {
    token,
    tokenHash: hashToken(token),
    familyId,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
  }
}