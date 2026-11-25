import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors.js";

export function requireRole(role: "admin" | "user") {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user || request.user.role !== role) {
      throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    }
  };
}