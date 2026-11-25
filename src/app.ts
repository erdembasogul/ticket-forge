import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type { FastifyError } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "./db/client.js";

import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { authRoutes } from "./modules/auth/auth.routes.js";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import { env } from "./config/env.js";
import { AppError } from "./lib/errors.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { eventsRoutes } from "./modules/events/events.routes.js";
import { ordersRoutes } from "./modules/orders/orders.routes.js";
import fastifyRawBody from "fastify-raw-body";
import { webhooksRoutes } from "./modules/webhooks/webhooks.routes.js";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { redisConnection } from "./lib/queue.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.passwordHash",
      ],
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "TicketForge API",
        version: "1.0.0"
      }
    },
    transform: jsonSchemaTransform,
  })

  await app.register(helmet);

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    redis: redisConnection,
  });

  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });


  await app.register(swaggerUI, {
    routePrefix: "/docs",
  })

  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET
  })

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "The requested resource was not found",
      code: "NOT_FOUND",
    })
  })

  app.setErrorHandler((error: FastifyError, _request, reply) => {

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        type: "about:blank",
        title: error.name,
        status: error.statusCode,
        detail: error.message,
        code: error.code,
      });
    }

    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;

    if (statusCode >= 500) {
      app.log.error(error);
    }

    return reply.status(statusCode).send({
      type: "about:blank",
      title: statusCode >= 500 ? "Internal Server Error" : error.name,
      status: statusCode,
      detail:
        statusCode >= 500
          ? "An unexpected error occurred"
          : error.message,
      code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
    });
  })

  app.get("/v1/health", async () => {
    return { status: "ok" };
  })

  app.get("/v1/health/ready", async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      await redisConnection.ping();
      return { status: "ready", checks: { database: "ok", redis: "ok" } };
    } catch (error) {
      app.log.error(error, "readiness check failed");
      return reply.status(503).send({
        status: "not_ready",
        checks: { database: "error", redis: "error" },
      });
    }
  });

  await app.register(authRoutes, { prefix: "/v1/auth" });
  await app.register(usersRoutes, { prefix: "/v1/users" });
  await app.register(eventsRoutes, { prefix: "/v1/events" })
  await app.register(ordersRoutes, { prefix: "/v1/orders" });

  await app.register(webhooksRoutes, { prefix: "/v1/webhooks" });


  return app;
}