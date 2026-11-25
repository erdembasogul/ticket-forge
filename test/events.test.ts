import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { hash } from "argon2";
import { randomUUID } from "node:crypto";
import { users } from "../src/db/schema";
import { db } from "../src/db/client";


describe("Events and Tickets API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    app = await buildApp();

    const passwordHash = await hash("Password123!");

    const adminEmail = `admin-${randomUUID()}@test.local`;
    const [adminUser] = await db
      .insert(users)
      .values({
        email: adminEmail,
        passwordHash,
        fullName: "Test Admin",
        role: "admin"
      })
      .returning();

    const userEmail = `user-${randomUUID()}@test.local`;
    const [normalUser] = await db
      .insert(users)
      .values({
        email: userEmail,
        passwordHash,
        fullName: "Normal User",
        role: "user",
      })
      .returning();

    const adminLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: adminEmail, password: "Password123!" },
    });
    adminToken = adminLogin.json().accessToken;

    const userLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: userEmail, password: "Password123!" },
    });
    userToken = userLogin.json().accessToken;
  })

  afterAll(async () => {
    await app.close();
  });

  let createdEventId: string;

  it("rejects event creation from non-admin users with 403", async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        title: "Unauthorized Event",
        description: "Should not be created by normal user",
        venue: "Secret Venue",
        city: "Istanbul",
        startsAt: futureDate.toISOString(),
        rows: 2,
        seatsPerRow: 5,
        priceCents: 10000,
      },
    })

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("FORBIDDEN")
  });


  it("allows admin to create an event with bulk seats", async () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10);

    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        title: "Rock Legends 2026",
        description: "Epic rock concert in Istanbul arena",
        venue: "BJK Stadium",
        city: "Istanbul",
        startsAt: futureDate.toISOString(),
        rows: 3,
        seatsPerRow: 4,
        priceCents: 35000,
        currency: "TRY",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.title).toBe("Rock Legends 2026");
    expect(body.status).toBe("draft");
    expect(body.totalSeats).toBe(12);

    createdEventId = body.id;
  });

  it("does not show draft events in public list", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/events",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const exists = body.data.some((e: { id: string }) => e.id === createdEventId);
    expect(exists).toBe(false);
  });

  it("allows admin to publish the event", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/events/${createdEventId}/publish`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("published")
  });

  it("rejects publishing an already published event with 409", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/events/${createdEventId}/publish`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("INVALID_EVENT_STATUS");
  });

  it("return event details with live available seats count", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/events/${createdEventId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(createdEventId);
    expect(body.status).toBe("published");
    expect(body.availableSeats).toBe(12);
  });

  it("returns seat map with correct labels", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/events/${createdEventId}/tickets?status=AVAILABLE`,
    });
    expect(response.statusCode).toBe(200);
    const tickets = response.json();
    expect(tickets).toHaveLength(12);
    expect(tickets[0].seatLabel).toBe("A-1");
    expect(tickets[11].seatLabel).toBe("C-4");
    expect(tickets.every((t: { status: string }) => t.status === "AVAILABLE")).toBe(true);
  });
})