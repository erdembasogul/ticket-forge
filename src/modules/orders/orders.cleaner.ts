import { and, eq, lt } from "drizzle-orm";
import { db } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { expireOrder } from "./orders.worker.js";

// Süresi geçmiş PENDING siparişleri bulup temizleyen fonksiyon
export async function cleanExpiredOrders(): Promise<number> {
  // expiresAt tarihi şu andan küçük (< NOW()) ve hala PENDING olanları bul
  const expiredOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "PENDING"),
        lt(orders.expiresAt, new Date()) // lt = Less Than (<)
      )
    );
  let cleanedCount = 0;
  for (const order of expiredOrders) {
    const success = await expireOrder(order.id);
    if (success) {
      cleanedCount++;
    }
  }
  return cleanedCount;
}

// 5 dakikada bir çalışan zamanlayıcıyı (Interval) başlatan fonksiyon
export function startFallbackCleaner(intervalMs = 5 * 60 * 1000) {
  const timer = setInterval(async () => {
    try {
      const count = await cleanExpiredOrders();
      if (count > 0) {
        console.log(`[Fallback Cleaner] Cleaned ${count} expired orders.`);
      }
    } catch (err) {
      console.error("[Fallback Cleaner] Error during cleanup:", err);
    }
  }, intervalMs);
  return timer;
}