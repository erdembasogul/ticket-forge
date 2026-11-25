import { z } from "zod";

//POST /v1/orders Body schema
export const createOrderBodySchema = z.object({
  ticketIds: z
    .array(z.uuid())
    .min(1, "At least 1 ticket must be selected")
    .max(6, "Maximum 6 tickets allowed per order")
    .refine((items) => new Set(items).size === items.length, {
      message: "Duplicate ticket IDs are not allowed"
    })
})

// Headers: idempotency-key
export const orderHeadersSchema = z.object({
  "idempotency-key": z.string().min(10).max(100)
})

// URL Parametreleri: /v1/orders/:id
export const orderParamsSchema = z.object({
  id: z.uuid()
})

// Order Item Response
export const orderItemResponseSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  priceCents: z.number().int()
})

export const orderResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  status: z.enum(["PENDING", "COMPLETED", "EXPIRED", "CANCELLED"]),
  totalCents: z.number().int(),
  currency: z.string(),
  expiresAt: z.date(),
  idempotencyKey: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  items: z.array(orderItemResponseSchema).optional(),
});

export const listOrdersResponseSchema = z.array(orderResponseSchema)

export const payOrderResponseSchema = z.object({
  url: z.string().url(),
  checkoutSessionId: z.string(),
});
