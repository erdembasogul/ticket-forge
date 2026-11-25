import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { authenticate } from "../auth/authenticate.js";
import { problemSchema } from "../../lib/problem.js";
import { orderItems, orders, tickets } from "../../db/schema.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import { orderExpiryQueue } from "../../lib/queue.js";
import { stripe } from "../../lib/stripe.js";
import {
  createOrderBodySchema,
  listOrdersResponseSchema,
  orderHeadersSchema,
  orderParamsSchema,
  orderResponseSchema,
  payOrderResponseSchema,
} from "./orders.schemas.js";


export const ordersRoutes: FastifyPluginAsyncZod = async (app) => {
  // Create order (Protected Route)
  app.post(
    "/",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["orders"],
        headers: orderHeadersSchema,
        body: createOrderBodySchema,
        response: {
          201: orderResponseSchema,
          200: orderResponseSchema,
          401: problemSchema,
          409: problemSchema
        },
      }
    },
    async (request, reply) => {
      const userId = request.user.sub;
      const idempotencyKey = request.headers["idempotency-key"] as string;
      const { ticketIds } = request.body;

      // 1. Idempotency Check
      const [existingOrder] = await db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.userId, userId),
            eq(orders.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1)

      if (existingOrder) {
        const items = await db
          .select({
            id: orderItems.id,
            ticketId: orderItems.ticketId,
            priceCents: orderItems.priceCents
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, existingOrder.id))

        return reply.status(200).send({
          ...existingOrder,
          items
        })
      }

      const newOrder = await db.transaction(async (tx) => {
        // const reservedTickets = await tx.execute<{
        //   id: string;
        //   price_cents: number;
        //   currency: string;
        // }>(sql`
        //   UPDATE tickets
        //   SET status = 'RESERVED', reserved_at = NOW()
        //   WHERE id = ANY(${ticketIds}) AND status = 'AVAILABLE'
        //   RETURNING id, price_cents, currency;
        //   `);

        // const reservedTickets = await tx
        //   .update(tickets)
        //   .set({ status: "RESERVED", reservedAt: new Date() })
        //   .where(
        //     and(
        //       inArray(tickets.id, ticketIds),
        //       eq(tickets.status, "AVAILABLE")
        //     )
        //   )
        //   .returning({
        //     id: tickets.id,
        //     priceCents: tickets.priceCents,
        //     currency: tickets.currency
        //   })

        const reservedTickets = await tx
          .select({
            id: tickets.id,
            priceCents: tickets.priceCents,
            currency: tickets.currency,
            status: tickets.status,
          })
          .from(tickets)
          .where(
            and(
              inArray(tickets.id, ticketIds),
              eq(tickets.status, "AVAILABLE")
            )
          )
          .for("update");

        if (reservedTickets.length !== ticketIds.length) {
          throw new AppError(
            409,
            "SEAT_UNAVAILABLE",
            "One or more requested seats are no longer available"
          )
        }

        await tx
          .update(tickets)
          .set({
            status: "RESERVED",
            reservedAt: new Date(),
          })
          .where(inArray(tickets.id, ticketIds));

        const totalCents = reservedTickets.reduce(
          (sum, t) => sum + t.priceCents, 0
        )
        const currency = reservedTickets[0]?.currency ?? "TRY";
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        const [order] = await db
          .insert(orders)
          .values({
            userId,
            status: "PENDING",
            totalCents,
            currency,
            expiresAt,
            idempotencyKey
          })
          .returning()

        if (!order) {
          throw new Error("Failed to create order");
        }

        const itemsToInsert = reservedTickets.map((t) => ({
          orderId: order.id,
          ticketId: t.id,
          priceCents: t.priceCents,
        }));

        const insertedItems = await tx
          .insert(orderItems)
          .values(itemsToInsert)
          .returning({
            id: orderItems.id,
            ticketId: orderItems.ticketId,
            priceCents: orderItems.priceCents
          })

        return {
          ...order,
          items: insertedItems
        }

      })

      // 10 dakika sonra çalışacak gecikmeli işi BullMQ'ya ekle
      await orderExpiryQueue.add(
        "expire-order",
        { orderId: newOrder.id },
        { delay: 10 * 60 * 1000 } // 10 dakika (milisaniye)
      );

      return reply.status(201).send(newOrder)
    }
  ),
    app.get(
      "/",
      {
        preHandler: [authenticate],
        schema: {
          tags: ["orders"],
          response: {
            200: listOrdersResponseSchema,
            401: problemSchema
          }
        }
      },
      async (request) => {
        const userId = request.user.sub;

        const userOrders = await db
          .select()
          .from(orders)
          .where(eq(orders.userId, userId));

        return userOrders
      }
    ),
    app.get(
      "/:id",
      {
        preHandler: [authenticate],
        schema: {
          tags: ["orders"],
          params: orderParamsSchema,
          response: {
            200: orderResponseSchema,
            401: problemSchema,
            404: problemSchema
          }
        }
      },
      async (request) => {
        const userId = request.user.sub;
        const { id } = request.params;

        const [order] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.id, id), eq(orders.userId, userId)))
          .limit(1);

        if (!order) {
          throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
        }

        const items = await db
          .select({
            id: orderItems.id,
            ticketId: orderItems.ticketId,
            priceCents: orderItems.priceCents,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id))

        return {
          ...order,
          items
        }
      }
    ),
    app.post(
      "/:id/cancel",
      {
        preHandler: [authenticate],
        schema: {
          tags: ["orders"],
          params: orderParamsSchema,
          response: {
            200: orderResponseSchema,
            401: problemSchema,
            404: problemSchema,
            409: problemSchema
          }
        }
      },
      async (request) => {
        const userId = request.user.sub;
        const { id } = request.params;

        const cancelledOrder = await db.transaction(async (tx) => {
          const [order] = await tx
            .select()
            .from(orders)
            .where(and(eq(orders.id, id), eq(orders.userId, userId)))
            .limit(1)
            .for("update")

          if (!order) {
            throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
          }

          if (order.status !== "PENDING") {
            throw new AppError(
              409,
              "ORDER_NOT_CANCELLABLE",
              `Cannot cancel an order with status "${order.status}"`
            );
          }

          const [updatedOrder] = await tx
            .update(orders)
            .set({
              status: "CANCELLED",
              updatedAt: new Date()
            })
            .where(eq(orders.id, id))
            .returning()

          const items = await tx
            .select({ ticketId: orderItems.ticketId })
            .from(orderItems)
            .where(eq(orderItems.orderId, id));

          const ticketIds = items.map((i) => i.ticketId);

          if (ticketIds.length > 0) {
            await tx
              .update(tickets)
              .set({
                status: "AVAILABLE",
                reservedAt: null,
              })
              .where(inArray(tickets.id, ticketIds));
          }
          return updatedOrder;
        })

        return cancelledOrder;
      }
    ),
    app.post(
      "/:id/pay",
      {
        preHandler: [authenticate],
        schema: {
          tags: ["orders"],
          params: orderParamsSchema,
          response: {
            200: payOrderResponseSchema,
            401: problemSchema,
            404: problemSchema,
            409: problemSchema,
          },
        },
      },
      async (request) => {
        const userId = request.user.sub;
        const { id } = request.params;
        // 1. Siparişi bul (IDOR korumalı: Sadece kendi siparişi)
        const [order] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.id, id), eq(orders.userId, userId)))
          .limit(1);
        if (!order) {
          throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
        }
        if (order.status !== "PENDING") {
          throw new AppError(
            409,
            "ORDER_NOT_PAYABLE",
            `Cannot pay for an order with status "${order.status}"`
          );
        }
        if (order.expiresAt.getTime() <= Date.now()) {
          throw new AppError(
            409,
            "ORDER_EXPIRED",
            "Order reservation has expired"
          );
        }
        // 2. Çifte ödeme koruması: Zaten açık bir Stripe session var mı?
        if (order.checkoutSessionId) {
          try {
            const existingSession = await stripe.checkout.sessions.retrieve(
              order.checkoutSessionId
            );
            if (existingSession.url && existingSession.status === "open") {
              return {
                url: existingSession.url,
                checkoutSessionId: existingSession.id,
              };
            }
          } catch {
            // Eski session Stripe tarafında geçersiz kalmışsa aşağıdan yenisini üretir
          }
        }
        // 3. Sıfırdan yeni bir Stripe Checkout Session oluştur
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          client_reference_id: order.id, // Webhook geldiğinde hangi sipariş olduğunu anlamak için!
          metadata: {
            orderId: order.id,
            userId: order.userId,
          },
          line_items: [
            {
              price_data: {
                currency: order.currency.toLowerCase(),
                unit_amount: order.totalCents, // Stripe kuruş cinsinden tutar bekler!
                product_data: {
                  name: `TicketForge Reservation #${order.id.slice(0, 8)}`,
                  description: "Event ticket reservation payment",
                },
              },
              quantity: 1,
            },
          ],
          success_url: `http://localhost:3000/v1/orders/${order.id}?payment=success`,
          cancel_url: `http://localhost:3000/v1/orders/${order.id}?payment=cancelled`,
        });
        if (!session.url) {
          throw new Error("Failed to create Stripe checkout session");
        }
        // 4. Üretilen session ID'yi siparişe kaydet (çifte oturum açılmasın)
        await db
          .update(orders)
          .set({
            checkoutSessionId: session.id,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id));
        return {
          url: session.url,
          checkoutSessionId: session.id,
        };
      }
    );
}