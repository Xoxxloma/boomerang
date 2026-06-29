CREATE TYPE "public"."entitlement_source" AS ENUM('trial', 'subscription', 'pass');--> statement-breakpoint
CREATE TYPE "public"."entitlement_tier" AS ENUM('free', 'pro');--> statement-breakpoint
CREATE TABLE "entitlements" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"tier" "entitlement_tier" DEFAULT 'free' NOT NULL,
	"active_until" timestamp with time zone,
	"source" "entitlement_source",
	"subscription_charge_id" text,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"telegram_payment_charge_id" text NOT NULL,
	"provider_payment_charge_id" text,
	"product" text NOT NULL,
	"stars_amount" integer NOT NULL,
	"invoice_payload" text NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"is_first_recurring" boolean DEFAULT false NOT NULL,
	"granted_from" timestamp with time zone NOT NULL,
	"granted_until" timestamp with time zone NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_charge_uq" ON "payments" USING btree ("telegram_payment_charge_id");--> statement-breakpoint
CREATE INDEX "payments_user_idx" ON "payments" USING btree ("user_id");