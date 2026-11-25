import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/db/client.js";
import { events, orderItems, orders, tickets, users } from "../../src/db/schema.js";
import { cleanExpiredOrders } from "../../src/modules/orders/orders.cleaner.js";
import { expireOrder } from "../../src/modules/orders/orders.worker.js";

describe("Order Expiry & Fallback Cleaner", () => {
  let userId: string;
  let eventId: string;

  beforeAll(async () => {
    const passwordHash = await hash("Password123!");
    const [user] = await db
      .insert(users)
      .values({
        email: `expiry-${randomUUID()}@test.local`,
        passwordHash,
        fullName: "Expiry Test User",
        role: "user",
      })
      .returning();

    userId = user!.id;

    const [event] = await db
      .insert(events)
      .values({
        title: "Expiry Concert",
        description: "Testing reservation expiration",
        venue: "Arena",
        city: "Istanbul",
        startsAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
        status: "published",
        createdBy: userId,
      })
      .returning();

    eventId = event!.id;
  });

  it("expireOrder marks PENDING order as EXPIRED and releases ticket", async () => {
    // 1. Rezerve edilmiş bir koltuk ve PENDING sipariş oluştur
    const [ticket] = await db
      .insert(tickets)
      .values({
        eventId,
        seatLabel: `EXP-${randomUUID().slice(0, 6)}`,
        priceCents: 10000,
        currency: "TRY",
        status: "RESERVED",
        reservedAt: new Date(),
      })
      .returning();

    const [order] = await db
      .insert(orders)
      .values({
        userId,
        status: "PENDING",
        totalCents: 10000,
        currency: "TRY",
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `exp-key-${randomUUID()}`,
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: order!.id,
      ticketId: ticket!.id,
      priceCents: 10000,
    });

    // 2. Worker'ın kullandığı fonksiyonu doğrudan çağır
    const expired = await expireOrder(order!.id);
    expect(expired).toBe(true);

    // 3. Sipariş EXPIRED, koltuk AVAILABLE olmalı
    const [updatedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, order!.id));
    const [updatedTicket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket!.id));

    expect(updatedOrder?.status).toBe("EXPIRED");
    expect(updatedTicket?.status).toBe("AVAILABLE");
    expect(updatedTicket?.reservedAt).toBeNull();
  });

  it("cleanExpiredOrders picks up past-due PENDING orders without Redis", async () => {
    const [ticket] = await db
      .insert(tickets)
      .values({
        eventId,
        seatLabel: `CLN-${randomUUID().slice(0, 6)}`,
        priceCents: 15000,
        currency: "TRY",
        status: "RESERVED",
        reservedAt: new Date(Date.now() - 120_000),
      })
      .returning();

    // expiresAt geçmişte (1 dakika önce dolmuş!)
    const [order] = await db
      .insert(orders)
      .values({
        userId,
        status: "PENDING",
        totalCents: 15000,
        currency: "TRY",
        expiresAt: new Date(Date.now() - 60_000),
        idempotencyKey: `cln-key-${randomUUID()}`,
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: order!.id,
      ticketId: ticket!.id,
      priceCents: 15000,
    });

    // Fallback cleaner'ı çalıştır
    const cleaned = await cleanExpiredOrders();
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const [updatedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, order!.id));
    const [updatedTicket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket!.id));

    expect(updatedOrder?.status).toBe("EXPIRED");
    expect(updatedTicket?.status).toBe("AVAILABLE");
  });
});