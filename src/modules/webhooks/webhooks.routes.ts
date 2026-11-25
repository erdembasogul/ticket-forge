import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { eq, inArray } from "drizzle-orm";
import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { orderItems, orders, payments, tickets } from "../../db/schema.js";
import { stripe } from "../../lib/stripe.js";

export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/stripe",
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"];

      if (!signature || typeof signature !== "string") {
        return reply.status(400).send({ error: "Missing stripe-signature header" });
      }

      const rawBody = request.rawBody;
      if (!rawBody) {
        return reply.status(400).send({ error: "Missing raw body" });
      }

      let event: Stripe.Event;

      // 1. Kriptografik imza doğrulama
      try {
        event = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          env.STRIPE_WEBHOOK_SECRET,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid signature";
        app.log.error(err, "Stripe webhook signature verification failed");
        return reply.status(400).send({ error: `Webhook Error: ${message}` });
      }

      // 2. Sadece ödeme tamamlandı olayını işle
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const orderId = session.client_reference_id;
        const providerPaymentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.id;
        const amountCents = session.amount_total ?? 0;

        if (!orderId) {
          app.log.warn({ sessionId: session.id }, "No orderId in Stripe session");
          return reply.status(200).send({ received: true });
        }

        // 3. Tek transaction içinde idempotent işleme
        await db.transaction(async (tx) => {
          const [insertedPayment] = await tx
            .insert(payments)
            .values({
              orderId,
              providerPaymentId,
              amountCents,
              status: "SUCCEEDED",
            })
            .onConflictDoNothing({ target: payments.providerPaymentId })
            .returning();

          // Aynı webhook daha önce geldiyse hiçbir şey yapma
          if (!insertedPayment) {
            app.log.info({ providerPaymentId }, "Duplicate webhook ignored");
            return;
          }

          // Siparişi kilitleyerek oku (.for("update"))
          const [order] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, orderId))
            .limit(1)
            .for("update");

          if (!order) {
            app.log.error({ orderId }, "Order not found for Stripe payment");
            return;
          }

          // Geç ödeme (sipariş zaten EXPIRED veya CANCELLED olmuşsa)
          if (order.status !== "PENDING") {
            app.log.warn(
              { orderId, status: order.status },
              "Late payment received for non-pending order, marking REFUND_PENDING",
            );
            await tx
              .update(payments)
              .set({ status: "REFUND_PENDING" })
              .where(eq(payments.id, insertedPayment.id));
            return;
          }

          // Normal akış: siparişi COMPLETED, koltukları SOLD yap
          await tx
            .update(orders)
            .set({
              status: "COMPLETED",
              updatedAt: new Date(),
            })
            .where(eq(orders.id, orderId));

          const items = await tx
            .select({ ticketId: orderItems.ticketId })
            .from(orderItems)
            .where(eq(orderItems.orderId, orderId));

          const ticketIds = items.map((i) => i.ticketId);

          if (ticketIds.length > 0) {
            await tx
              .update(tickets)
              .set({ status: "SOLD" })
              .where(inArray(tickets.id, ticketIds));
          }
        });
      }

      return reply.status(200).send({ received: true });
    },
  );
};