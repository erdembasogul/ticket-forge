import { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { beforeAll, describe, afterAll, it, expect } from "vitest";


describe("API foundation", () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp();
  })

  afterAll(async () => {
    await app.close()
  })

  it("returns ok status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    })

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
    })
  })

  it("returns problem details for unknown routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/does-not-exist",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  })
})