import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import z from "zod";
import { problemSchema } from "../../lib/problem.js";
import { hash, verify } from "argon2";
import { refreshTokens, users } from "../../db/schema.js";
import { db } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import { and, eq, isNull } from "drizzle-orm";
import { createRefreshToken, hashToken } from "./tokens.js";


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

const loginBody = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
})

const loginResponse = z.object({
  accessToken: z.string(),
  user: userResponse,
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
        throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
      }

      return reply.status(201).send(user)
    }
  ),
    app.post(
      "/login",
      {
        schema: {
          tags: ["auth"],
          body: loginBody,
          response: {
            200: loginResponse,
            401: problemSchema
          }
        }
      },
      async (request, reply) => {
        const email = request.body.email.toLowerCase();

        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            fullName: users.fullName,
            role: users.role,
            passwordHash: users.passwordHash,
          })
          .from(users)
          .where(eq(users.email, email))
          .limit(1)

        // Kullanıcı yoksa da sahte verify: timing ile email sızmasın
        const passwordHash =
          user?.passwordHash ??
          "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

        const valid = await verify(passwordHash, request.body.password).catch(
          () => false,
        );

        if (!user || !valid) {
          throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
        }

        const accessToken = await reply.jwtSign(
          { sub: user.id, role: user.role },
          { expiresIn: "15m" }
        )

        const refresh = createRefreshToken();

        await db.insert(refreshTokens).values({
          userId: user.id,
          tokenHash: refresh.tokenHash,
          familyId: refresh.familyId,
          expiresAt: refresh.expiresAt,
        });

        reply.setCookie("refreshToken", refresh.token, {
          path: "/v1/auth",
          httpOnly: true,
          sameSite: "lax",
          secure: false, // production'da true
          expires: refresh.expiresAt,
        });

        return {
          accessToken,
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
          },
        };

      }
    ),
    app.post(
      "/refresh",
      {
        schema: {
          tags: ["auth"],
          response: {
            200: loginResponse,
            401: problemSchema
          }
        }
      },
      async (request, reply) => {
        const rawToken = request.cookies.refreshToken;

        if (!rawToken) {
          throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token missing");
        }

        const tokenHash = hashToken(rawToken);

        const [stored] = await db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash))
          .limit(1);

        if (!stored) {
          throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token invalid");
        }

        if (stored.revokedAt) {
          await db
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(refreshTokens.familyId, stored.familyId),
                isNull(refreshTokens.revokedAt),
              ),
            );

          reply.clearCookie("refreshToken", { path: "/v1/auth" });

          throw new AppError(
            401,
            "REFRESH_TOKEN_REUSE",
            "Refresh token reuse detected",
          );
        }

        if (stored.expiresAt.getTime() <= Date.now()) {
          throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token expired");
        }

        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            fullName: users.fullName,
            role: users.role,
          })
          .from(users)
          .where(eq(users.id, stored.userId))
          .limit(1);

        if (!user) {
          throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token invalid");
        }

        // Eski refresh'i iptal et (rotation)
        await db
          .update(refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(refreshTokens.id, stored.id));

        // Aynı family ile yeni refresh
        const next = createRefreshToken(stored.familyId);

        await db.insert(refreshTokens).values({
          userId: user.id,
          tokenHash: next.tokenHash,
          familyId: next.familyId,
          expiresAt: next.expiresAt,
        });

        const accessToken = await reply.jwtSign(
          { sub: user.id, role: user.role },
          { expiresIn: "15m" },
        );

        reply.setCookie("refreshToken", next.token, {
          path: "/v1/auth",
          httpOnly: true,
          sameSite: "lax",
          secure: false,
          expires: next.expiresAt,
        });

        return {
          accessToken,
          user,
        };
      }
    ),
    app.post(
      "/logout",
      {
        schema: {
          tags: ["auth"],
          response: {
            204: z.undefined(),
          }
        }
      },
      async (request, reply) => {
        const rawToken = request.cookies.refreshToken;

        if (rawToken) {
          const tokenHash = hashToken(rawToken);

          await db
            .update(refreshTokens)
            .set({ revokedAt: new Date() })
            .where(eq(refreshTokens.tokenHash, tokenHash))
        }

        reply.clearCookie("refreshToken", { path: "/v1/auth" });
        return reply.status(204).send();
      }
    )
}