import { Worker, type Job } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orderItems, orders, tickets } from "../../db/schema.js";
import {
  ORDER_EXPIRY_QUEUE_NAME,
  type OrderExpiryJobData,
  redisConnection,
} from "../../lib/queue.js";

// 1. Süresi Dolan Tek Bir Siparişi İptal Eden Çekirdek Fonksiyon
export async function expireOrder(orderId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    // Koşullu Güncelleme: Sadece hala PENDING ise EXPIRED yap!
    const [expiredOrder] = await tx
      .update(orders)
      .set({
        status: "EXPIRED",
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "PENDING")))
      .returning({ id: orders.id });
    // Eğer 0 satır döndüyse: Sipariş zaten COMPLETED veya CANCELLED olmuştur. Dokunma!
    if (!expiredOrder) {
      return false;
    }
    // Bu siparişteki koltukları bul
    const items = await tx
      .select({ ticketId: orderItems.ticketId })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    const ticketIds = items.map((i) => i.ticketId);
    // Koltukları tekrar AVAILABLE yap (salona geri dönsünler!)
    if (ticketIds.length > 0) {
      await tx
        .update(tickets)
        .set({
          status: "AVAILABLE",
          reservedAt: null,
        })
        .where(
          and(
            inArray(tickets.id, ticketIds),
            eq(tickets.status, "RESERVED") // Sadece hala RESERVED olanları aç
          )
        );
    }
    return true;
  });
}

// 2. BullMQ Worker'ı (Redis'ten gelen gecikmeli işleri karşılar)
export function createOrderExpiryWorker() {
  const worker = new Worker<OrderExpiryJobData>(
    ORDER_EXPIRY_QUEUE_NAME,
    async (job: Job<OrderExpiryJobData>) => {
      const { orderId } = job.data;
      await expireOrder(orderId);
    },
    {
      connection: redisConnection,
      concurrency: 5, // Aynı anda en fazla 5 işi paralel işlesin
    }
  );
  worker.on("failed", (job, err) => {
    console.error(`Order expiry job ${job?.id} failed:`, err);
  });
  return worker;
}
