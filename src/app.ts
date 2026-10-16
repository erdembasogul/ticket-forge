import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import type { FastifyError } from "fastify";

export async function buildApp() {
  const app = Fastify({
    logger: true
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "TicketForge API",
        version: "1.0.0"
      }
    }
  })

  await app.register(swaggerUI, {
    routePrefix: "/docs",
  })

  app.get("/v1/health", async () => {
    return { status: "ok" };
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

  return app;
}