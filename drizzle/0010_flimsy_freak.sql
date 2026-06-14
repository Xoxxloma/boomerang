CREATE TYPE "public"."remind_status" AS ENUM('pending', 'sent', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "remind_pending" (
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remind_pending_chat_id_message_id_pk" PRIMARY KEY("chat_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "remind_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "remind_status" "remind_status";--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "remind_created_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "items_remind_due_idx" ON "items" USING btree ("remind_status","remind_at") WHERE "items"."remind_at" is not null;