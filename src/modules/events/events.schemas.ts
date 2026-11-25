import z from "zod";


export const createEventBodySchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(2000),
  venue: z.string().trim().min(2).max(100),
  city: z.string().trim().min(2).max(100),
  startsAt: z.coerce.date().refine((date) => date.getTime() > Date.now(),
    {
      message: "startsAt must be a future date",
    }),
  rows: z.number().int().min(1).max(26),
  seatsPerRow: z.number().int().min(1).max(100),
  priceCents: z.number().int().positive(),
  currency: z.string().length(3).default("TRY")
})

export const eventResponseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string(),
  venue: z.string(),
  city: z.string(),
  startsAt: z.date(),
  status: z.enum(["draft", "published", "cancelled"]),
  createdBy: z.uuid(),
  createdAt: z.date(),
  updatedAt: z.date(),
  totalSeats: z.number().int().optional(),
})

export const listEventsQuerySchema = z.object({
  city: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional()
})

export const listEventResponseSchema = z.object({
  data: z.array(eventResponseSchema),
  nextCursor: z.string().nullable()
})

export const eventsParamsSchema = z.object({
  id: z.uuid()
})

export const eventDetailResponseSchema = eventResponseSchema.extend({
  availableSeats: z.number().int()
})

export const listTicketsQuerySchema = z.object({
  status: z.enum(["AVAILABLE", "RESERVED", "SOLD"]).optional(),
})

export const ticketResponseSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  seatLabel: z.string(),
  priceCents: z.number().int(),
  currency: z.string(),
  status: z.enum(["AVAILABLE", "RESERVED", "SOLD"]),
});

export const listTicketsResponseSchema = z.array(ticketResponseSchema);