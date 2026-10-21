import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { randomUUID } from "node:crypto";


describe("GET /v1/users/me", () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let accessToken: string;
  let email: string;

  beforeAll(async () => {
    app = await buildApp();

    email = `me-${randomUUID()}@test.local`;

    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: "Password123!", fullName: "Me User" }
    })

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        email,
        password: "Password123!",
      },
    });

    expect(login.statusCode).toBe(200);
    accessToken = login.json().accessToken;
  })

  afterAll(async () => {
    await app.close();
  })

  it("returns the current user when token is valid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/users/me",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    })

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      email,
      fullName: "Me User",
      role: "user",
    });
  })

  it("return 401 when Authorization is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/users/me",
    })

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("UNAUTHORIZED");
  })

})
