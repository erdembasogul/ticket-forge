import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { randomUUID } from "node:crypto";


describe("POST /v1/auth/register", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  })

  afterAll(async () => {
    await app.close();
  })

  function uniqueEmail() {
    return `user-${randomUUID()}@test.local`;
  }

  it("creates a user and never returns the password hash", async () => {
    const email = uniqueEmail();

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: "Password123!", fullName: "Test User" }
    })

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ email, fullName: "Test User", role: "user" })
    expect(body).not.toHaveProperty("passwordHash");
  })

  it("ignores a role sent by the client", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: {
        email: uniqueEmail(),
        password: "Password123!",
        fullName: "Test User",
        role: "admin"
      }
    })

    expect(response.statusCode).toBe(201);
    expect(response.json().role).toBe("user");
  })

  it("rejects a duplicate email with 409", async () => {
    const email = uniqueEmail();
    const payload = { email, password: "Password123!", fullName: "Test User" };

    await app.inject({ method: "POST", url: "/v1/auth/register", payload });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { ...payload, email: email.toUpperCase() },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("EMAIL_TAKEN");
  })

  it("rejects an invalid body with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "not-an-email", password: "short", fullName: "" },
    });
    expect(response.statusCode).toBe(400);
  });
}) 