import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";
import { problemSchema } from "../../lib/problem.js";
import { hash } from "argon2";
import { users } from "../../db/schema.js";
import { db } from "../../db/client.js";


const registerBody = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(1).max(100),
})

const userResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  role: z.enum(["admin", "user"])
})

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/register",
    {
      schema: {
        tags: ["auth"],
        body: registerBody,
        response: {
          201: userResponse,
          409: problemSchema
        }
      }
    },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      const passwordHash = await hash(request.body.password);

      const [user] = await db
        .insert(users)
        .values({
          email, passwordHash, fullName: request.body.fullName
        })
        .onConflictDoNothing({ target: users.email })
        .returning({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          role: users.role
        });

      if (!user) {
        return reply.status(409).send({
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "An account with this email already exists",
          code: "EMAIL_TAKEN"
        })
      }

      return reply.status(201).send(user)
    }
  )
}