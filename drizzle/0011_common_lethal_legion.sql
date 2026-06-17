ALTER TABLE "clusters" ADD COLUMN "maturity_milestone" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Бэкфилл: уже зрелые кластеры (слали maturity) переводим на текущий кратный порогу рубеж по их size,
-- чтобы после деплоя они не «выстрелили» повторно сразу, а ждали следующего кратного (10, 15…).
UPDATE "clusters" SET "maturity_milestone" = ("size" / 5) * 5 WHERE "matured_at" IS NOT NULL;