import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { authenticate } from "../auth/authenticate.js";
import { requireRole } from "../auth/roles.js";
import { createEventBodySchema, eventDetailResponseSchema, eventResponseSchema, eventsParamsSchema, listEventResponseSchema, listEventsQuerySchema, listTicketsQuerySchema, listTicketsResponseSchema } from "./events.schemas.js";
import { problemSchema } from "../../lib/problem.js";
import { db } from "../../db/client.js";
import { events, tickets } from "../../db/schema.js";
import { and, asc, count, eq, gt, or } from "drizzle-orm";
import { AppError } from "../../lib/errors.js";


export const eventsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/",
    {
      preHandler: [authenticate, requireRole("admin")],
      schema: {
        tags: ["events"],
        body: createEventBodySchema,
        response: {
          201: eventResponseSchema,
          401: problemSchema,
          403: problemSchema
        }
      }
    },
    async (request, reply) => {
      const {
        title, description, venue, city, startsAt, rows, seatsPerRow, priceCents, currency
      } = request.body;

      const result = await db.transaction(async (tx) => {
        const [event] = await tx
          .insert(events)
          .values({
            title,
            description,
            venue,
            city,
            startsAt,
            status: "draft",
            createdBy: request.user.sub,
          })
          .returning()

        if (!event) {
          throw new Error("Failed to create event")
        }

        const seatValues: (typeof tickets.$inferInsert)[] = [];

        for (let r = 0; r < rows; r++) {
          const rowLetter = String.fromCharCode(65 + r);

          for (let s = 1; s <= seatsPerRow; s++) {
            seatValues.push({
              eventId: event.id,
              seatLabel: `${rowLetter}-${s}`,
              priceCents,
              currency,
              status: "AVAILABLE",
            });
          }
        }

        await tx.insert(tickets).values(seatValues);

        return {
          ...event,
          totalSeats: seatValues.length
        }

      })

      return reply.status(201).send(result);
    }
  ),
    app.get(
      "/",
      {
        schema: {
          tags: ["events"],
          querystring: listEventsQuerySchema,
          response: {
            200: listEventResponseSchema
          }
        }
      },
      async (request) => {
        const { city, limit, cursor } = request.query;

        const conditions = [];

        conditions.push(eq(events.status, "published"));

        if (city) {
          conditions.push(eq(events.city, city));
        }

        if (cursor) {
          try {
            const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
            const [startsAtStr, id] = decoded.split("_");
            if (startsAtStr && id) {
              const cursorDate = new Date(startsAtStr);
              conditions.push(
                or(
                  gt(events.startsAt, cursorDate),
                  and(eq(events.startsAt, cursorDate), gt(events.id, id))
                )
              )
            }
          } catch { }
        }

        const items = await db
          .select()
          .from(events)
          .where(and(...conditions))
          .orderBy(asc(events.startsAt), asc(events.id))
          .limit(limit + 1);

        let nextCursor: string | null = null;

        // Eğer limit'ten fazla kayıt geldiyse sonraki sayfa var demektir
        if (items.length > limit) {
          items.pop(); // Fazlalık olan (limit + 1). kaydı çıkar
          const lastItem = items[items.length - 1];
          if (lastItem) {
            const raw = `${lastItem.startsAt.toISOString()}_${lastItem.id}`;
            nextCursor = Buffer.from(raw).toString("base64url");
          }
        }

        return {
          data: items,
          nextCursor
        }

      }
    ),
    app.get(
      "/:id",
      {
        schema: {
          tags: ["events"],
          params: eventsParamsSchema,
          response: {
            200: eventDetailResponseSchema,
            404: problemSchema
          }
        }
      },
      async (request) => {
        const { id } = request.params;

        const [event] = await db
          .select()
          .from(events)
          .where(eq(events.id, id))
          .limit(1)

        if (!event) {
          throw new AppError(404, "EVENT_NOT_FOUND", "Event not found")
        }

        const [seatsCount] = await db
          .select({ value: count() })
          .from(tickets)
          .where(
            and(
              eq(tickets.eventId, event.id),
              eq(tickets.status, "AVAILABLE")
            )
          )

        return {
          ...event,
          availableSeats: seatsCount?.value ?? 0
        }
      }
    ),
    app.get(
      "/:id/tickets",
      {
        schema: {
          tags: ["events"],
          params: eventsParamsSchema,
          querystring: listTicketsQuerySchema,
          response: {
            200: listTicketsResponseSchema,
            404: problemSchema
          }
        }
      },
      async (request) => {
        const { id } = request.params;
        const { status } = request.query;

        const [event] = await db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.id, id))
          .limit(1);

        if (!event) {
          throw new AppError(404, "EVENT_NOT_FOUND", "Event not found");
        }

        const conditions = [eq(tickets.eventId, id)];

        if (status) {
          conditions.push(eq(tickets.status, status));
        }

        const eventTickets = await db
          .select({
            id: tickets.id,
            eventId: tickets.eventId,
            seatLabel: tickets.seatLabel,
            priceCents: tickets.priceCents,
            currency: tickets.currency,
            status: tickets.status,
          })
          .from(tickets)
          .where(and(...conditions))
          .orderBy(asc(tickets.seatLabel))

        return eventTickets
      }
    ),
    app.post(
      "/:id/publish",
      {
        preHandler: [authenticate, requireRole("admin")],
        schema: {
          tags: ["events"],
          params: eventsParamsSchema,
          response: {
            200: eventResponseSchema,
            401: problemSchema,
            403: problemSchema,
            404: problemSchema,
            409: problemSchema,
          }
        }
      },
      async (request, reply) => {
        const { id } = request.params;

        const [event] = await db
          .select()
          .from(events)
          .where(eq(events.id, id))
          .limit(1)

        if (!event) {
          throw new AppError(404, "EVENT_NOT_FOUND", "Event not found")
        }

        if (event.status !== "draft") {
          throw new AppError(409, "INVALID_EVENT_STATUS", `Cannot publish an event with status "${event.status}"`)
        }

        if (event.startsAt.getTime() <= Date.now()) {
          throw new AppError(
            409,
            "EVENT_ALREADY_PASSED",
            "Cannot publish an event that has already passed"
          );
        }

        const [updatedEvent] = await db
          .update(events)
          .set({
            status: "published",
            updatedAt: new Date(),
          })
          .where(eq(events.id, id))
          .returning();

        if (!updatedEvent) {
          throw new Error("Failed to update event");
        }

        return reply.status(200).send(updatedEvent);
      }
    )
}