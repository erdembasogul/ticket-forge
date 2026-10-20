import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";
import { authenticate } from "../auth/authenticate.js";
import { problemSchema } from "../../lib/problem.js";
import { db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { AppError } from "../../lib/errors.js";


const userResponse = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  role: z.enum(["user", "admin"])
})

export const usersRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/me",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["users"],
        response: {
          200: userResponse,
          401: problemSchema,
          404: problemSchema,
        }
      }
    },
    async (request) => {
      const [user] = await db
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
          role: users.role,
        })
        .from(users)
        .where(eq(users.id, request.user.sub))
        .limit(1);

      if (!user) {
        throw new AppError(404, "USER_NOT_FOUND", "User not found");
      }

      return user;
    }
  )
}