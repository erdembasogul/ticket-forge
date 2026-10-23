import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { randomUUID } from "node:crypto";


function cookieHeader(setCookie: string | string[] | undefined) {
  if (!setCookie) return "";
  const parts = Array.isArray(setCookie) ? setCookie : [setCookie];
  // "refreshToken=...; Path=/v1/auth; HttpOnly" → sadece "refreshToken=..."
  return parts.map((c) => c.split(";")[0]).join("; ");
}

describe("POST /v1/auth/logout", () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let email: string;
  let password: string;
  let loginCookie: string;

  beforeAll(async () => {
    app = await buildApp();

    email = `refresh-${randomUUID()}@test.local`;
    password = "Password123!";

    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password, fullName: "Logout User" },
    })

    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    })

    expect(login.statusCode).toBe(200);
    loginCookie = cookieHeader(login.headers["set-cookie"]);
    expect(loginCookie).toContain("refreshToken=");
  })

  afterAll(async () => {
    await app.close();
  })

  it("revokes the refresh token so it cannot be refreshed again", async () => {

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: {
        Cookie: loginCookie,
      },
    })

    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toBeDefined();

    const refreshWithRevokedToken = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: {
        Cookie: loginCookie,
      },
    })

    expect(refreshWithRevokedToken.statusCode).toBe(401);
    expect(refreshWithRevokedToken.json().code).toBe("REFRESH_TOKEN_REUSE");
  })

  it("should succeed even without a refresh cookie", async () => {
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
    })
    expect(logout.statusCode).toBe(204);
  })
})