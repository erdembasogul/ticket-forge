import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { randomUUID } from "node:crypto";

function cookieHeader(setCookie: string | string[] | undefined) {
  if (!setCookie) return "";
  const parts = Array.isArray(setCookie) ? setCookie : [setCookie];
  return parts.map((c) => c.split(";")[0]).join("; ");
}

describe("POST /v1/auth/refresh", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
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
      payload: { email, password, fullName: "Refresh User" },
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

  it("returns a new access token when refresh cookie is valid", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: {
        Cookie: loginCookie,
      },
    })

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toEqual(expect.any(String));
    expect(response.json().user.email).toBe(email);

    const nextCookie = cookieHeader(response.headers["set-cookie"]);
    expect(nextCookie).toContain("refreshToken=");
  })

  it("rejects reuse of an already rotated refresh token", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });
    const firstCookie = cookieHeader(login.headers["set-cookie"]);

    const firstRefresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: firstCookie },
    });
    expect(firstRefresh.statusCode).toBe(200);

    const reused = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: firstCookie },
    });

    expect(reused.statusCode).toBe(401);
    expect(reused.json().code).toBe("REFRESH_TOKEN_REUSE");
  })

  it("returns 401 when refresh cookie is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("INVALID_REFRESH_TOKEN");
  });
})