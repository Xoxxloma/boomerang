ALTER TABLE "clusters" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "edit_pending" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "surfacing_log" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "clusters" CASCADE;--> statement-breakpoint
DROP TABLE "edit_pending" CASCADE;--> statement-breakpoint
DROP TABLE "surfacing_log" CASCADE;--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_cluster_id_clusters_id_fk";
--> statement-breakpoint
DROP INDEX "items_cluster_idx";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "cluster_id";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "cluster_locked";--> statement-breakpoint
DROP TYPE "public"."surfacing_kind";