/**
 * Бэкафилл документов, оставшихся без тела (rawText пуст): раньше .xlsx не читался вовсе,
 * а сбой чтения был тихим. Скрипт переоткрывает гейты L2 (indexed_at, embedding) и ставит
 * записи в общую очередь l2-process — БОТ ДОЛЖЕН БЫТЬ ЗАПУЩЕН (его воркеры обработают).
 *
 * По умолчанию только кандидаты .xlsx (теперь читаются exceljs). Сканы-PDF без OCR (фаза 4)
 * перечитывать бессмысленно — тот же пустой результат за деньги. `--all` снимает фильтр.
 * Идемпотентен: повторный прогон добирает упавших (у них indexed_at останется NULL).
 *
 * Запуск: npm run backfill:docs [-- --all]
 */
import { and, eq, isNotNull, or, isNull, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { items } from '../src/db/schema.js';
import { getCluster, recomputeClusterStats } from '../src/db/clusters.js';
import { startBoss, stopBoss } from '../src/queue/boss.js';
import { enqueueProcess } from '../src/queue/index.js';

const all = process.argv.includes('--all');

const candidates = await db
  .select()
  .from(items)
  .where(
    and(
      eq(items.type, 'document'),
      isNotNull(items.tgFileId),
      or(isNull(items.rawText), sql`btrim(${items.rawText}) = ''`),
      ...(all ? [] : [sql`${items.title} ~* '\\.xlsx$'`]),
    ),
  );

if (candidates.length === 0) {
  console.log(`Кандидатов нет (фильтр: ${all ? 'все пустые документы' : 'только .xlsx'}).`);
  process.exit(0);
}

console.log(`Кандидатов: ${candidates.length} (${all ? 'все пустые документы' : 'только .xlsx'})`);
await startBoss();

let sent = 0;
for (const it of candidates) {
  const prevClusterId = it.clusterId;
  const prevName = prevClusterId ? ((await getCluster(prevClusterId))?.name ?? null) : null;

  // Открываем гейты L2: indexed_at=NULL → документ перечитается; embedding=NULL → переэмбеддится
  // уже С телом. cluster_id сбрасываем только без ручного lock — раскладку юзера не трогаем.
  await db
    .update(items)
    .set({
      indexedAt: null,
      embedding: null,
      ...(it.clusterLocked ? {} : { clusterId: null }),
    })
    .where(eq(items.id, it.id));

  // Запись «ушла» из кластера — его центроид/size не должны её помнить.
  if (!it.clusterLocked && prevClusterId) await recomputeClusterStats(prevClusterId);

  // seed = старое имя кластера: консервативно (категория не скачет); если эмбеддинг тела реально
  // ляжет к другой теме — assignCluster переложит сам.
  await enqueueProcess(it.id, prevName ?? 'Разное');
  sent += 1;
  console.log(`→ ${it.id} «${(it.title ?? '').slice(0, 50)}» (было: ${prevName ?? 'без кластера'})`);
}

await stopBoss();
console.log(`Готово: поставлено в очередь ${sent}. Обработают воркеры бота (он должен работать).`);
process.exit(0);
