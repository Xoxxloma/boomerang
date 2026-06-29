CREATE TABLE "access_reminders" (
	"user_id" bigint NOT NULL,
	"active_until" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "access_reminders_uq" ON "access_reminders" USING btree ("user_id","active_until","kind");--> statement-breakpoint
ALTER TABLE "entitlements" DROP COLUMN "subscription_charge_id";--> statement-breakpoint
ALTER TABLE "entitlements" DROP COLUMN "auto_renew";