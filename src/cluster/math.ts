/** Косинусная близость двух векторов одинаковой длины: [−1..1], выше = ближе. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Инкрементальное обновление центроида: среднее по (size) старым + 1 новый вектор. */
export function updatedCentroid(centroid: number[], size: number, next: number[]): number[] {
  const out = new Array<number>(next.length);
  for (let i = 0; i < next.length; i++) {
    out[i] = (centroid[i]! * size + next[i]!) / (size + 1);
  }
  return out;
}
