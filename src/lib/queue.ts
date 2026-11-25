import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { Queue } from "bullmq";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // BullMQ için bu ayarın null olması zorunludur!
});

export const ORDER_EXPIRY_QUEUE_NAME = "order-expiry";

export interface OrderExpiryJobData {
  orderId: string;
}

//BullMQ
export const orderExpiryQueue = new Queue<OrderExpiryJobData>(
  ORDER_EXPIRY_QUEUE_NAME,
  {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: true, // Başarıyla biten işleri Redis'ten temizle (bellek şişmesin)
      removeOnFail: 100, // Hata alan son 100 işi incelemek için sakla
    },
  }
);