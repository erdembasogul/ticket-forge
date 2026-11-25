import "dotenv/config";
import { startFallbackCleaner } from "./modules/orders/orders.cleaner.js";
import { createOrderExpiryWorker } from "./modules/orders/orders.worker.js";
import { redisConnection } from "./lib/queue.js";

const worker = createOrderExpiryWorker();
const cleanerTimer = startFallbackCleaner();

console.log("TicketForge worker started (BullMQ + fallback cleaner)");

// Ctrl+C (SIGINT) veya Docker durdurma (SIGTERM) gelince yarım iş bırakmadan temiz kapan
async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down worker...`);
  clearInterval(cleanerTimer);
  await worker.close();
  await redisConnection.quit();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));