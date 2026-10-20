import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors.js";


export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
}