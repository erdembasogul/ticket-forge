# TicketForge

[Türkçe](#türkçe) | [English](#english)

---

## Türkçe

TicketForge, bilet satışı ve koltuk rezervasyonu süreçlerinde yaşanan **race condition (aynı koltuğun aynı anda iki kişiye satılması)**, **süreli koltuk tutma** ve **ödeme webhook tekrarları** gibi gerçek backend problemlerini çözmek için geliştirdiğim bir Node.js / TypeScript API projesidir.

> **Mevcut Durum:** Backend çekirdeği, 31 entegrasyon testi, Dockerfile ve GitHub Actions CI tamamlandı. Sırada bu API'nin üstüne ince bir Next.js ön yüzü ve canlı deploy var.

### Neleri Çözdüm?

1. **Çift Satış Önleme (Row-Level Locking & Transaction):**
   - Koltuk rezervasyonunda önce `SELECT` atıp sonra `UPDATE` yapmak yerine, tek bir PostgreSQL transaction'ı içinde `SELECT ... WHERE status = 'AVAILABLE' FOR UPDATE` ile satırları açıkça kilitliyorum.
   - İstenen koltuk sayısı ile kilitlenen sayı eşleşmezse transaction `ROLLBACK` oluyor ve `409 Conflict` dönüyor (**ya hepsi ya hiçbiri**).
   - 10 paralel isteğin aynı koltuk için yarıştığı entegrasyon testinde tam 1 istek `201`, 9 istek `409` alıyor.

2. **Idempotency-Key & Güvenli Sipariş Akışı:**
   - `POST /v1/orders` isteğinde `Idempotency-Key` başlığı zorunlu. Çift tıklama veya ağ tekrarında ikinci sipariş açılmıyor, mevcut sipariş `200 OK` ile dönüyor.
   - Sipariş detayında ve iptalde IDOR koruması (`WHERE id = $1 AND user_id = $2`).
   - İptal işleminde (`POST /v1/orders/:id/cancel`) sipariş satırı `FOR UPDATE` ile kilitlenip iptal ediliyor ve koltuklar tekrar `AVAILABLE` durumuna çekiliyor.

3. **Süreli Rezervasyon (BullMQ + Fallback Cleaner):**
   - Sipariş açıldığında 10 dakikalık gecikmeli (delayed) iş BullMQ kuyruğuna atılıyor.
   - Ayrı bir worker süreci (`src/worker.ts`) süre dolunca yalnızca hâlâ `PENDING` olan siparişleri `EXPIRED` yapıp koltukları serbest bırakıyor.
   - Redis çökmesine veya kayıp işlere karşı 5 dakikada bir çalışan yedek SQL temizleyici (`orders.cleaner.ts`) devrede.

4. **Stripe Ödeme & Idempotent Webhook:**
   - `POST /v1/orders/:id/pay` mevcut açık bir Checkout Session varsa yenisini açmadan onu dönüyor (çifte tahsilat koruması).
   - `POST /v1/webhooks/stripe` ham gövde (`fastify-raw-body`) ile `stripe-signature` doğrulaması yapıyor.
   - `payments.provider_payment_id` üzerindeki `UNIQUE` kısıtı + `ON CONFLICT DO NOTHING` ile aynı webhook birden fazla kez gelse de tek işlem yapılıyor.
   - Süresi dolmuş (`EXPIRED`) veya iptal edilmiş siparişe geç ödeme gelirse koltuk `SOLD` yapılmıyor, ödeme `REFUND_PENDING` olarak işaretleniyor.

5. **Kimlik Doğrulama & Güvenlik:**
   - **Argon2id** şifre hashleme ve olmayan kullanıcılar için sahte doğrulama ile timing-attack koruması.
   - Kısa ömürlü (15 dk) stateless JWT access token + `HttpOnly` cookie içinde taşınan, DB'de SHA-256 hash'li refresh token.
   - **Rotation & Reuse Detection:** İptal edilmiş eski bir refresh token tekrar kullanılırsa o `family_id` altındaki tüm oturumlar iptal ediliyor.
   - Helmet, CORS, Redis tabanlı rate limiting, RFC 9457 hata formatı ve Pino log maskeleme (`redact`).

---

### Kullanılan Araçlar

- **Runtime & Dil:** Node.js 24 LTS, TypeScript (`strict`, `NodeNext`, `noUncheckedIndexedAccess`)
- **API & Validasyon:** Fastify 5, Zod (`fastify-type-provider-zod`), Swagger UI (`/docs`)
- **Veritabanı & Kuyruk:** PostgreSQL 16, Drizzle ORM, Redis 7 (`ioredis`), BullMQ
- **Ödeme & Güvenlik:** Stripe SDK, `fastify-raw-body`, Argon2, `@fastify/jwt`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`
- **Test & DevOps:** Vitest (`app.inject`), Docker (multi-stage build), GitHub Actions CI

---

### Yerel Kurulum

Gereksinimler: Node 24+, pnpm, Docker

```bash
# 1. Repoyu klonla ve bağımlılıkları kur
git clone https://github.com/erdembasogul/ticket-forge.git
cd ticket-forge
pnpm install

# 2. Ortam değişkenlerini kopyala
cp .env.example .env

# 3. PostgreSQL ve Redis container'larını başlat
docker compose up -d

# 4. Tabloları oluştur ve örnek veriyi yükle
pnpm db:migrate
pnpm db:seed

# 5. API sunucusunu başlat (ayrı terminalde worker için: pnpm dev:worker)
pnpm dev
```

- Swagger Dokümantasyonu: `http://localhost:3000/docs`
- Liveness: `http://localhost:3000/v1/health`
- Readiness (PostgreSQL + Redis): `http://localhost:3000/v1/health/ready`

Testleri ve tip kontrolünü çalıştırmak için:
```bash
pnpm typecheck
pnpm test
```

---

### Sırada Ne Var?

- [x] Auth (Register, Login, Refresh Rotation + Reuse Detection, Logout, Role Guard)
- [x] Etkinlikler & Koltuk Envanteri (Bulk seat insert, Cursor pagination, Canlı `COUNT`, Publish)
- [x] Siparişler & Atomik Rezervasyon (`FOR UPDATE`, Idempotency-Key, Eşzamanlılık testi)
- [x] BullMQ TTL Worker + Fallback SQL Cleaner
- [x] Stripe Checkout + İmza Doğrulamalı, Idempotent Webhook
- [x] Helmet, CORS, Redis Rate Limit, Dockerfile & GitHub Actions CI
- [ ] Next.js Ön Yüz (Etkinlik listesi, koltuk haritası, Stripe ödeme akışı)
- [ ] Canlı Deploy & k6 Yük Testi

---
---

## English

TicketForge is a Node.js / TypeScript backend API built around real-world ticketing challenges: **preventing seat overbooking under concurrent load**, **expiring unpaid reservations reliably**, and **handling idempotent payment webhooks**.

> **Status:** Core backend, 31 integration tests, multi-stage Dockerfile, and GitHub Actions CI are complete. Next up: a thin Next.js frontend and live deployment.

### Key Problems Solved

1. **Zero Overbooking (Row-Level Locking & Transactions):**
   - Seat reservations run inside a PostgreSQL transaction using explicit `SELECT ... WHERE status = 'AVAILABLE' FOR UPDATE` locking.
   - If fewer rows are locked than requested, the transaction rolls back with `409 Conflict` (**all-or-nothing**).
   - Verified with a 10-way concurrent race condition test where exactly 1 request returns `201` and 9 return `409`.

2. **Idempotent Orders & Safe Cancellation:**
   - `POST /v1/orders` requires an `Idempotency-Key` header so duplicate clicks return the existing order (`200 OK`) instead of creating double bookings.
   - Order reads and cancellations enforce ownership checks (`WHERE id = $1 AND user_id = $2`).
   - `POST /v1/orders/:id/cancel` locks the order row (`FOR UPDATE`), transitions it to `CANCELLED`, and releases seats back to `AVAILABLE`.

3. **Timed Reservations (BullMQ + Fallback Cleaner):**
   - Each order schedules a 10-minute delayed BullMQ job handled by a dedicated worker process (`src/worker.ts`).
   - Conditional SQL updates (`WHERE status = 'PENDING'`) ensure paid orders are never expired.
   - A 5-minute fallback SQL cleaner (`orders.cleaner.ts`) recovers expired orders even if Redis drops jobs.

4. **Stripe Checkout & Idempotent Webhooks:**
   - `POST /v1/orders/:id/pay` reuses an existing open Checkout Session if present.
   - `POST /v1/webhooks/stripe` verifies `stripe-signature` against the raw request body (`fastify-raw-body`).
   - Duplicate webhooks are safely ignored via `UNIQUE (provider_payment_id)` + `ON CONFLICT DO NOTHING`.
   - Late payments arriving for already `EXPIRED` or `CANCELLED` orders do not sell the seats; they are flagged as `REFUND_PENDING`.

5. **Authentication & Security:**
   - **Argon2id** hashing with dummy-hash verification to mitigate login timing attacks.
   - 15-minute stateless JWT access tokens + SHA-256 hashed refresh tokens in `HttpOnly` cookies.
   - **Rotation & Reuse Detection:** Replaying a revoked refresh token revokes the entire `family_id` session chain.
   - Helmet, CORS, Redis-backed rate limiting, RFC 9457 Problem Details errors, and Pino log redaction.

---

### Tech Stack

- **Runtime & Language:** Node.js 24 LTS, TypeScript (`strict`, `NodeNext`, `noUncheckedIndexedAccess`)
- **API & Validation:** Fastify 5, Zod (`fastify-type-provider-zod`), Swagger UI (`/docs`)
- **Database & Queue:** PostgreSQL 16, Drizzle ORM, Redis 7 (`ioredis`), BullMQ
- **Payments & Security:** Stripe SDK, `fastify-raw-body`, Argon2, `@fastify/jwt`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`
- **Testing & DevOps:** Vitest (`app.inject`), multi-stage Dockerfile, GitHub Actions CI

---

### Getting Started

Prerequisites: Node 24+, pnpm, Docker

```bash
# Clone and install
git clone https://github.com/erdembasogul/ticket-forge.git
cd ticket-forge
pnpm install

# Configure environment
cp .env.example .env

# Start PostgreSQL and Redis
docker compose up -d

# Run migrations and seed data
pnpm db:migrate
pnpm db:seed

# Start API server (run worker in a second terminal: pnpm dev:worker)
pnpm dev
```

- Swagger UI: `http://localhost:3000/docs`
- Liveness: `http://localhost:3000/v1/health`
- Readiness (PostgreSQL + Redis): `http://localhost:3000/v1/health/ready`

Run checks and tests:
```bash
pnpm typecheck
pnpm test
```
