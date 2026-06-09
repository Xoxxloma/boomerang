CREATE TYPE "public"."item_type" AS ENUM('link', 'tg_post', 'document', 'image', 'video', 'text', 'voice');--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"centroid" vector(1536),
	"size" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" bigint NOT NULL,
	"source_chat" text,
	"type" "item_type" NOT NULL,
	"raw_text" text,
	"url" text,
	"title" text,
	"description" text,
	"ocr_text" text,
	"transcript" text,
	"file_path" text,
	"embedding" vector(1536),
	"cluster_id" uuid,
	"cluster_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"indexed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"import_done" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clusters_user_idx" ON "clusters" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "clusters_centroid_idx" ON "clusters" USING hnsw ("centroid" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "items_user_idx" ON "items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "items_cluster_idx" ON "items" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "items_embedding_idx" ON "items" USING hnsw ("embedding" vector_cosine_ops);