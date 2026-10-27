# TicketForge 🎟️

> 🚧 **Geliştirme Aşamasında (Work in Progress)**  
> Bu proje aktif olarak geliştirilmektedir. Temel veritabanı mimarisi ve güvenli Auth altyapısı tamamlandı; etkinlik yönetimi ve atomik rezervasyon motoru üzerinde çalışıyorum.

[English](#english) | [Türkçe](#türkçe)

---

## Türkçe

TicketForge, bilet satışı ve koltuk rezervasyonu süreçlerinde ortaya çıkan **race condition (aynı koltuğun aynı anda birden fazla kişiye satılması)** problemini çözmek amacıyla üzerinde çalıştığım bir Node.js / TypeScript backend projesidir.

Amacım basit bir CRUD API yapmak değil; yüksek trafik altında veritabanı tutarlılığı (ACID), token güvenliği ve arka plan iş kuyrukları gibi backend dünyasının gerçek problemlerini adım adım, test güdümlü (TDD) inşa etmek.

### 📍 Şu An Neredeyim? (Mevcut Durum)

#### ✅ Tamamlanan Kısımlar:
1. **Veritabanı & Altyapı:**
   - PostgreSQL 16 (Docker Compose) ve Drizzle ORM ile 7 tablonun şeması kuruldu, migration ve seed scriptleri hazırlandı.
   - Para birimlerinde floating-point hatalarını engellemek için tutarları doğrudan kuruş cinsinden `integer` (`price_cents`) olarak tuttum.
   - RFC 9457 uyumlu Problem Details hata formatı ve `/v1/health/ready` (DB ping) endpoint'i hazır.
2. **Güvenli Kimlik Doğrulama (Auth Engine):**
   - **Argon2id:** Şifreleri güvenli hash'liyoruz. Giriş yaparken kullanıcı bulunamasa bile timing attack (kullanıcı saydırma) riskini önlemek için sahte hash doğrulaması koşturuyorum.
   - **JWT + HttpOnly Cookie:** Kısa ömürlü (15 dk) access token ve veritabanında SHA-256 hash'i saklanan uzun ömürlü refresh token mimarisi.
   - **Rotation & Reuse Detection:** Her refresh işleminde token yenileniyor. Daha önce kullanılmış (iptal edilmiş) bir refresh token tekrar gelirse, sistem bunu çalınma kabul edip o oturum zincirindeki (`family_id`) tüm token'ları tek sorguda iptal ediyor.
   - Vitest ile auth akışının (register, login, refresh, reuse detection, logout) tüm entegrasyon testlerini yazdım.

---

#### 🚧 Şu An Üzerinde Çalıştığım ve Sırada Olanlar:
1. **Etkinlikler & Koltuk Envanteri (Sıradaki Adım):**
   - Cursor-based pagination ile etkinlik listeleme ve koltuk durumlarını (`AVAILABLE`, `RESERVED`, `SOLD`) dönme.
2. **Atomik Rezervasyon Motoru (Temel Hedef):**
   - Rezervasyon için Redis lock kurmak yerine, PostgreSQL'in satır kilidi gücünü kullanmayı planlıyorum:
     ```sql
     UPDATE tickets
     SET status = 'RESERVED', reserved_at = NOW()
     WHERE id = ANY($1) AND status = 'AVAILABLE'
     RETURNING id;
     ```
   - Dönen satır sayısı istenen koltuk sayısından azsa transaction `ROLLBACK` edilecek ve istemciye `409 Conflict` dönecek.
   - 100 eşzamanlı istek / 5 koltuk senaryosunu k6 yük testi ile doğrulayacağım.
3. **BullMQ ile Süreli Rezervasyon:**
   - 10 dakika içinde ödeme gelmezse koltukları otomatik serbest bırakan gecikmeli (delayed) kuyruk işçisi ve Redis çökmesine karşı fallback SQL cleaner.

---

### 🛠️ Teknoloji Tercihleri

- **Fastify:** Düşük overhead, yerleşik Pino loglama ve güçlü plugin yapısı.
- **TypeScript & Node 24:** `strict`, `NodeNext`, `noUncheckedIndexedAccess` ile derleme anında tam tip güvenliği.
- **PostgreSQL 16 & Drizzle ORM:** Saf SQL kontrolünü kaybetmeden tip güvenli sorgular.
- **Vitest:** `app.inject()` ile gerçek port açmadan hızlı HTTP entegrasyon testleri.

---

### 🚀 Yerel Olarak Çalıştırma

Gereksinimler: Node 24+, pnpm, Docker

```bash
# 1. Repoyu klonla ve bağımlılıkları kur
git clone https://github.com/erdembasogul/ticket-forge.git
cd ticket-forge
pnpm install

# 2. Ortam değişkenlerini kopyala
cp .env.example .env

# 3. PostgreSQL container'ını başlat
docker compose up -d

# 4. Tabloları oluştur ve test verisini yükle
pnpm db:migrate
pnpm db:seed

# 5. Sunucuyu başlat
pnpm dev
```

- Swagger UI: `http://localhost:3000/docs`
- Sağlık Kontrolü: `http://localhost:3000/v1/health/ready`

Mevcut testleri koşmak için:
```bash
pnpm test
```

---
---

## English

> 🚧 **Work in Progress**  
> This repository is actively under development. The database schema and production-grade auth flow are fully completed and tested; event management and the atomic reservation engine are currently being built.

TicketForge is a Node.js and TypeScript backend project designed to tackle **concurrency and race conditions during high-demand seat reservations**.

The goal of this project is not just building a standard CRUD API, but learning and implementing real-world backend architectures: database transactions (ACID), token rotation with reuse detection, and delayed worker queues.

### 📍 Current Status

#### ✅ What is completed so far:
1. **Core Data Layer & Infrastructure:**
   - PostgreSQL 16 (Docker Compose) and Drizzle ORM managing 7 relational tables with migrations and seed scripts.
   - Currency math is kept strictly in integer cents (`price_cents`) to avoid floating-point inaccuracies.
   - RFC 9457 Problem Details error handling and database readiness checks (`/v1/health/ready`).
2. **Production-Grade Authentication:**
   - **Argon2id:** Password hashing with timing-attack mitigation (dummy verification if user is not found to prevent email enumeration).
   - **Stateless Access & State-Controlled Refresh:** 15-minute JWT access tokens + SHA-256 hashed refresh tokens stored in `HttpOnly` cookies.
   - **Rotation & Reuse Detection:** Tokens are rotated on every `/refresh`. Replaying an already-revoked token triggers immediate invalidation of the entire `family_id` session chain.
   - Full integration test suite covering auth edge cases with Vitest.

---

#### 🚧 In Progress & What I am building next:
1. **Events & Seating Inventory (Current Step):**
   - Cursor-based pagination for event discovery and seat status tracking (`AVAILABLE`, `RESERVED`, `SOLD`).
2. **Atomic Reservation Engine (Core Focus):**
   - Instead of relying on Redis distributed locks, planning to utilize PostgreSQL row-level locks:
     ```sql
     UPDATE tickets
     SET status = 'RESERVED', reserved_at = NOW()
     WHERE id = ANY($1) AND status = 'AVAILABLE'
     RETURNING id;
     ```
   - Partial updates will trigger a transaction `ROLLBACK` and return `409 Conflict`.
   - Concurrency will be validated with k6 load testing (e.g. 100 concurrent requests competing for 5 seats).
3. **Queue TTL (BullMQ) & Stripe Integration:**
   - 10-minute delayed reservation expiry jobs backed by a fallback SQL cleaner.

---

### 🛠️ Tech Stack & Choices

- **Fastify:** Performance, modular plugin architecture, and native Pino logging over Express.
- **TypeScript & Node 24:** Strict type checks (`NodeNext`, `noUncheckedIndexedAccess`).
- **PostgreSQL 16 & Drizzle ORM:** Strict schema migrations with full SQL control.
- **Vitest:** In-memory integration testing with `app.inject()`.

---

### 🚀 Getting Started

Prerequisites: Node 24+, pnpm, Docker

```bash
# Clone and install dependencies
git clone https://github.com/erdembasogul/ticket-forge.git
cd ticket-forge
pnpm install

# Setup environment variables
cp .env.example .env

# Start database
docker compose up -d

# Run migrations & seed data
pnpm db:migrate
pnpm db:seed

# Start development server
pnpm dev
```

- Swagger API Docs: `http://localhost:3000/docs`
- Readiness check: `http://localhost:3000/v1/health/ready`

Run test suite:
```bash
pnpm test
```
