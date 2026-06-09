CREATE TABLE "burst_part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "burst_session" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"progress_chat_id" bigint,
	"progress_message_id" bigint,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "burst_part_user_idx" ON "burst_part" USING btree ("user_id");