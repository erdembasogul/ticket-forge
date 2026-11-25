import { randomUUID } from "node:crypto";
import { hash } from "argon2";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { db } from "../../src/db/client.js";
import {
  events,
  orderItems,
  orders,
  payments,
  tickets,
  users,
} from "../../src/db/schema.js";
import { stripe } from "../../src/lib/stripe.js";

function signedWebhookPayload(
  orderId: string,
  paymentIntentId: string,
  amountCents: number,
) {
  const payload = JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${randomUUID()}`,
        object: "checkout.session",
        client_reference_id: orderId,
        payment_intent: paymentIntentId,
        amount_total: amountCents,
      },
    },
  });

  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });

  return { payload, signature };
}

describe("POST /v1/webhooks/stripe", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userId: string;
  let eventId: string;

  beforeAll(async () => {
    app = await buildApp();

    const passwordHash = await hash("Password123!");
    const [user] = await db
      .insert(users)
      .values({
        email: `webhook-${randomUUID()}@test.local`,
        passwordHash,
        fullName: "Webhook Test User",
        role: "user",
      })
      .returning();

    userId = user!.id;

    const [event] = await db
      .insert(events)
      .values({
        title: "Webhook Live",
        description: "Testing Stripe webhooks",
        venue: "Arena",
        city: "Istanbul",
        startsAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
        status: "published",
        createdBy: userId,
      })
      .returning();

    eventId = event!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects requests with an invalid stripe signature", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=invalid_signature",
      },
      payload: JSON.stringify({ type: "checkout.session.completed" }),
    });

    expect(response.statusCode).toBe(400);
  });

  it("completes order, marks ticket SOLD, and ignores duplicate webhooks", async () => {
    const [ticket] = await db
      .insert(tickets)
      .values({
        eventId,
        seatLabel: `WH-${randomUUID().slice(0, 6)}`,
        priceCents: 25000,
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
        totalCents: 25000,
        currency: "TRY",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        idempotencyKey: `wh-key-${randomUUID()}`,
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: order!.id,
      ticketId: ticket!.id,
      priceCents: 25000,
    });

    const paymentIntentId = `pi_test_${randomUUID()}`;
    const { payload, signature } = signedWebhookPayload(
      order!.id,
      paymentIntentId,
      25000,
    );

    // 1. geliş: siparişi tamamla ve koltuğu SOLD yap
    const first = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
    expect(first.statusCode).toBe(200);

    // 2. geliş (aynı ödeme idempotency testi): yine 200 dönmeli, ikinci ödeme yazmamalı
    const second = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
    expect(second.statusCode).toBe(200);

    const [updatedOrder] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, order!.id));
    const [updatedTicket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket!.id));
    const orderPayments = await db
      .select()
      .from(payments)
      .where(eq(payments.orderId, order!.id));

    expect(updatedOrder?.status).toBe("COMPLETED");
    expect(updatedTicket?.status).toBe("SOLD");
    expect(orderPayments).toHaveLength(1);
    expect(orderPayments[0]?.status).toBe("SUCCEEDED");
  });

  it("marks late payment on an EXPIRED order as REFUND_PENDING", async () => {
    const [ticket] = await db
      .insert(tickets)
      .values({
        eventId,
        seatLabel: `LATE-${randomUUID().slice(0, 6)}`,
        priceCents: 20000,
        currency: "TRY",
        status: "AVAILABLE", // süre dolunca serbest kalmış
      })
      .returning();

    const [order] = await db
      .insert(orders)
      .values({
        userId,
        status: "EXPIRED",
        totalCents: 20000,
        currency: "TRY",
        expiresAt: new Date(Date.now() - 60_000),
        idempotencyKey: `late-key-${randomUUID()}`,
      })
      .returning();

    await db.insert(orderItems).values({
      orderId: order!.id,
      ticketId: ticket!.id,
      priceCents: 20000,
    });

    const { payload, signature } = signedWebhookPayload(
      order!.id,
      `pi_late_${randomUUID()}`,
      20000,
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
    expect(response.statusCode).toBe(200);

    const [updatedTicket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket!.id));
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.orderId, order!.id));

    // Koltuk başkasına kalmış olabilir, SOLD yapılmamalı!
    expect(updatedTicket?.status).toBe("AVAILABLE");
    expect(payment?.status).toBe("REFUND_PENDING");
  });
});