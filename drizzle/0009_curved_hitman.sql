-- Слияние одноимённых (CI) кластеров перед уникальным индексом: дубли возникали из гонки
-- check-then-create (assignCluster / clusterThematic) — items перевешиваем на выжившего
-- (больший size, затем старший updated_at, затем id — детерминизм), затем дубли удаляем.
WITH ranked AS (
  SELECT id, user_id, lower(name) AS lname,
         row_number() OVER (PARTITION BY user_id, lower(name)
                            ORDER BY size DESC, updated_at ASC, id ASC) AS rn
  FROM clusters
)
UPDATE items i SET cluster_id = s.id
FROM ranked d
JOIN ranked s ON s.user_id = d.user_id AND s.lname = d.lname AND s.rn = 1
WHERE d.rn > 1 AND i.cluster_id = d.id;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY user_id, lower(name)
                                ORDER BY size DESC, updated_at ASC, id ASC) AS rn
  FROM clusters
)
DELETE FROM clusters c USING ranked d WHERE c.id = d.id AND d.rn > 1;
--> statement-breakpoint
-- Пересчёт centroid/size всех кластеров от истины (эквивалент recomputeClusterStats):
-- выжившие вобрали чужие items, их статистика устарела. Дёшево на текущем масштабе.
UPDATE clusters c SET
  centroid = (SELECT avg(embedding) FROM items WHERE cluster_id = c.id AND embedding IS NOT NULL),
  size     = (SELECT count(*) FROM items WHERE cluster_id = c.id),
  updated_at = now();
--> statement-breakpoint
CREATE UNIQUE INDEX "clusters_user_name_ci_uq" ON "clusters" USING btree ("user_id",lower("name"));