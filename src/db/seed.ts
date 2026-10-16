import { hash } from "argon2";
import { db } from "./client.js";
import { events, tickets, users } from "./schema.js";


async function seed() {
  const passwordHash = await hash("Password123!");

  const [admin] = await db
    .insert(users)
    .values({
      email: "admin@ticketforget.local",
      passwordHash,
      fullName: "Admin User",
      role: "admin"
    })
    .onConflictDoNothing()
    .returning();

  const [user] = await db
    .insert(users)
    .values({
      email: "user@ticketforget.local",
      passwordHash,
      fullName: "User User",
      role: "user"
    })
    .onConflictDoNothing()
    .returning();

  const createdBy = admin?.id ?? user?.id;

  if (!createdBy) {
    throw new Error("No user available to create event");
  }

  const [event] = await db
    .insert(events)
    .values({
      title: "Istanbul Night Live",
      description: "Sample concert for TicketForge",
      venue: "Volkswagen Arena",
      city: "Istanbul",
      startsAt: new Date("2026-12-01T20:00:00.000Z"),
      status: "published",
      createdBy,
    })
    .returning();

  if (!event) {
    throw new Error("Event was not created");
  }

  const seatValues = ["A-1", "A-2", "A-3", "A-4", "A-5"].map((seatLabel) => ({
    eventId: event.id,
    seatLabel,
    priceCents: 25000,
    currency: "TRY",
    status: "AVAILABLE" as const,
  }));

  await db.insert(tickets).values(seatValues);

  console.log("Seed completed");
  console.log({
    adminEmail: "admin@ticketforge.local",
    userEmail: "user@ticketforge.local",
    password: "Password123!",
    eventId: event.id,
    seats: seatValues.map((s) => s.seatLabel),
  });

  process.exit(0);
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});