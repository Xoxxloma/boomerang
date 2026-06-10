ALTER TABLE "items" ADD COLUMN "media_group_id" text;--> statement-breakpoint
CREATE INDEX "items_user_media_group_idx" ON "items" USING btree ("user_id","media_group_id");