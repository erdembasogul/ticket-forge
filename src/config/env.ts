import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.url(),
  PORT: z.coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(3000),
})

export const env = envSchema.parse(process.env);