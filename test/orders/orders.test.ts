import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { hash } from "argon2";
import { randomUUID } from "node:crypto";
import { db } from "../../src/db/client";
import { events, tickets, users } from "../../src/db/schema";
import { eq } from "drizzle-orm";


describe("Orders & Concurrency API", () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let user1Token: string;
  let user1Id: string;
  let user2Token: string;
  let user2Id: string;
  let eventId: string;
  let testTickets: { id: string; seatLabel: string }[];

  beforeAll(async () => {
    app = await buildApp();
    const passwordHash = await hash("Password123!");

    const email1 = `order-user1-${randomUUID()}@test.local`;
    const [u1] = await db
      .insert(users)
      .values({
        email: email1,
        passwordHash,
        fullName: "Order User 1",
        role: "user",
      })
      .returning();
    user1Id = u1.id;
    const email2 = `order-user2-${randomUUID()}@test.local`;
    const [u2] = await db
      .insert(users)
      .values({
        email: email2,
        passwordHash,
        fullName: "Order User 2",
        role: "user",
      })
      .returning();
    user2Id = u2.id;

    const l1 = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: email1, password: "Password123!" },
    });
    user1Token = l1.json().accessToken;

    const l2 = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: email2, password: "Password123!" },
    });
    user2Token = l2.json().accessToken;

    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 5);
    const [createdEvent] = await db
      .insert(events)
      .values({
        title: "Concurrency Rock Fest",
        description: "Test event for concurrency",
        venue: "Arena",
        city: "Istanbul",
        startsAt: futureDate,
        status: "published",
        createdBy: user1Id,
      })
      .returning();
    eventId = createdEvent.id;

    testTickets = await db
      .insert(tickets)
      .values([
        { eventId, seatLabel: "T-1", priceCents: 15000, currency: "TRY", status: "AVAILABLE" },
        { eventId, seatLabel: "T-2", priceCents: 15000, currency: "TRY", status: "AVAILABLE" },
        { eventId, seatLabel: "T-3", priceCents: 15000, currency: "TRY", status: "AVAILABLE" },
        { eventId, seatLabel: "T-4", priceCents: 15000, currency: "TRY", status: "AVAILABLE" },
        { eventId, seatLabel: "T-5", priceCents: 15000, currency: "TRY", status: "AVAILABLE" },
      ])
      .returning({ id: tickets.id, seatLabel: tickets.seatLabel });
  })

  afterAll(async () => {
    await app.close();
  });

  // TEST 1: Successful reservation
  it("creates an order and reserves tickets", async () => {
    const t1 = testTickets[0].id;
    const t2 = testTickets[1].id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: {
        authorization: `Bearer ${user1Token}`,
        "idempotency-key": `key-${randomUUID()}`
      },
      payload: {
        ticketIds: [t1, t2]
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("PENDING");
    expect(body.totalCents).toBe(30000);
    expect(body.items).toHaveLength(2);

    const [dbT1] = await db.select().from(tickets).where(eq(tickets.id, t1));
    expect(dbT1.status).toBe("RESERVED");
  })

  // TEST 2: Idempotency
  it("return existing order when the same idempotency key is reused", async () => {
    const t3 = testTickets[2].id;
    const sameKey = `idemp-key-${randomUUID()}`;

    const res1 = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: {
        authorization: `Bearer ${user1Token}`,
        "idempotency-key": sameKey
      },
      payload: { ticketIds: [t3] }
    });

    expect(res1.statusCode).toBe(201);
    const orderId1 = res1.json().id;

    const res2 = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: {
        authorization: `Bearer ${user1Token}`,
        "idempotency-key": sameKey
      },
      payload: { ticketIds: [t3] }
    });

    expect(res2.statusCode).toBe(200);
    expect(res1.json().id).toBe(orderId1);
  })

  // TEST 3: Rollback
  it("rejects partial availability and rolls back (all or nothing)", async () => {
    const reservedSeat = testTickets[0].id;
    const availableSeat = testTickets[3].id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: {
        authorization: `Bearer ${user2Token}`,
        "idempotency-key": `key-${randomUUID()}`,
      },
      payload: { ticketIds: [reservedSeat, availableSeat] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("SEAT_UNAVAILABLE");

    const [seat] = await db.select().from(tickets).where(eq(tickets.id, availableSeat));
    expect(seat.status).toBe("AVAILABLE");
  })

  // TEST 4: EŞZAMANLILIK YARIŞI (10 İstek / 1 Koltuk)
  it("handles race condition: exactly 1 wins out of 10 concurrent requests", async () => {
    const targetSeat = testTickets[4].id;

    const requests = Array.from({ length: 10 }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/v1/orders",
        headers: {
          authorization: `Bearer ${i % 2 === 0 ? user1Token : user2Token}`,
          "idempotency-key": `race-key-${i}-${randomUUID()}`,
        },
        payload: { ticketIds: [targetSeat] },
      })
    );

    const responses = await Promise.all(requests);

    const successes = responses.filter((r) => r.statusCode === 201);
    const conflicts = responses.filter((r) => r.statusCode === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
  });

  // TEST 5: Sipariş İptali ve Koltuk Bırakma
  it("cancels an order and releases the seats back to AVAILABLE", async () => {

    const [newSeat] = await db
      .insert(tickets)
      .values({ eventId, seatLabel: "CANCEL-1", priceCents: 10000, currency: "TRY", status: "AVAILABLE" })
      .returning();

    const orderRes = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: {
        authorization: `Bearer ${user1Token}`,
        "idempotency-key": `cancel-key-${randomUUID()}`,
      },
      payload: { ticketIds: [newSeat.id] },
    });

    const orderId = orderRes.json().id;

    const cancelRes = await app.inject({
      method: "POST",
      url: `/v1/orders/${orderId}/cancel`,
      headers: { authorization: `Bearer ${user1Token}` },
    });

    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().status).toBe("CANCELLED");

    const [releasedSeat] = await db.select().from(tickets).where(eq(tickets.id, newSeat.id));
    expect(releasedSeat.status).toBe("AVAILABLE");
    expect(releasedSeat.reservedAt).toBeNull();
  });
})