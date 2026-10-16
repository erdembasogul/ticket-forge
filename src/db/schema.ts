import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  uniqueIndex,
  index,
  unique,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["user", "admin"])
export const eventStatusEnum = pgEnum("event_status", [
  "draft", "published", "cancelled"
])
export const ticketStatusEnum = pgEnum("ticket_status", [
  "AVAILABLE",
  "RESERVED",
  "SOLD",
]);
export const orderStatusEnum = pgEnum("order_status", [
  "PENDING",
  "COMPLETED",
  "EXPIRED",
  "CANCELLED",
]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "REFUND_PENDING",
  "REFUNDED",
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  venue: text("venue").notNull(),
  city: text("city").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  status: eventStatusEnum("status").notNull().default("draft"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  familyId: uuid("family_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    seatLabel: text("seat_label").notNull(),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("TRY"),
    status: ticketStatusEnum("status").notNull().default("AVAILABLE"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.eventId, table.seatLabel),
    index("tickets_event_id_status_idx").on(table.eventId, table.status),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: orderStatusEnum("status").notNull().default("PENDING"),
    totalCents: integer("total_cents").notNull(),
    currency: text("currency").notNull().default("TRY"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    checkoutSessionId: text("checkout_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.userId, table.idempotencyKey),
    index("orders_user_id_idx").on(table.userId),
    index("orders_status_expires_at_idx").on(table.status, table.expiresAt),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id),
    priceCents: integer("price_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.orderId, table.ticketId),
    index("order_items_order_id_idx").on(table.orderId),
    index("order_items_ticket_id_idx").on(table.ticketId),
  ],
);

export const payments = pgTable("payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  providerPaymentId: text("provider_payment_id").notNull().unique(),
  status: paymentStatusEnum("status").notNull().default("PENDING"),
  amountCents: integer("amount_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});