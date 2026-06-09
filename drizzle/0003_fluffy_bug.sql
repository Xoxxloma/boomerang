CREATE TYPE "public"."surfacing_kind" AS ENUM('resonance', 'maturity');--> statement-breakpoint
CREATE TABLE "surfacing_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"kind" "surfacing_kind" NOT NULL,
	"item_id" uuid,
	"cluster_id" uuid,
	"trigger_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "matured_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "surfacing_user_idx" ON "surfacing_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "surfacing_user_item_idx" ON "surfacing_log" USING btree ("user_id","item_id");