export const EDGE_OUTBOUND_CONCURRENCY = 5;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workerCount = Math.min(items.length, Math.max(1, normalizedLimit));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
