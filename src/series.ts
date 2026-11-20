import { minute } from "./decide";
import type { GuardDb } from "./guard-db";
import type { DecisionRecord, StatusStore } from "./web/store";

const ranges = { "1h": [5, 12], "24h": [60, 24], "7d": [360, 28] } as const;
export type SeriesRange = keyof typeof ranges;

export function isSeriesRange(value: string | null): value is SeriesRange {
  return value !== null && Object.hasOwn(ranges, value);
}

type SeriesBucket = { start: string; successes: number; errors: number };
export type SeriesResponse = {
  range: SeriesRange;
  bucketMinutes: number;
  from: string;
  to: string;
  accounts: { id: number; buckets: SeriesBucket[]; events: DecisionRecord[] }[];
};

export type SeriesWindow = Pick<SeriesResponse, "from" | "to" | "bucketMinutes">;
export type SeriesQuery = (window: SeriesWindow, ids: number[], errorPatterns: string[]) => Promise<{
  successes: SeriesCount[];
  errors: SeriesCount[];
}>;

export type SeriesCount = { accountId: number | string; start: number | string; count: number | string };

export function createSeries(store: StatusStore, decisions: Pick<GuardDb["decisions"], "since">, query: SeriesQuery, now = Date.now) {
  const cache = new Map<SeriesRange, { key: string; expiresAt: number; result: Promise<SeriesResponse> }>();

  async function load(range: SeriesRange, requestedAt: number, ids: number[], patterns: string[]): Promise<SeriesResponse> {
    const [bucketMinutes, count] = ranges[range];
    const width = bucketMinutes * minute;
    const start = Math.floor(requestedAt / width) * width - (count - 1) * width;
    const from = new Date(start).toISOString();
    const to = new Date(requestedAt).toISOString();
    const series = { range, bucketMinutes, from, to };
    if (ids.length === 0) return { ...series, accounts: [] };

    const traffic = await query({ bucketMinutes, from, to }, ids, patterns);
    const starts = Array.from({ length: count }, (_, index) => new Date(start + index * width).toISOString());
    const accounts = ids.map((id) => ({
      id,
      buckets: starts.map((start) => ({ start, successes: 0, errors: 0 })),
      events: [] as DecisionRecord[],
    }));
    const byId = new Map(accounts.map((account) => [account.id, account]));
    for (const kind of ["successes", "errors"] as const) {
      for (const row of traffic[kind]) {
        const bucket = byId.get(Number(row.accountId))?.buckets[(Number(row.start) - start) / width];
        if (bucket) bucket[kind] = Number(row.count);
      }
    }
    for (const event of decisions.since(from)) byId.get(event.id)?.events.push(event);
    return { ...series, accounts };
  }

  return function getSeries(range: SeriesRange): Promise<SeriesResponse> {
    const requestedAt = now();
    const ids = store.accountIds();
    const { value: { errorPatterns } } = store.getSettings();
    const key = JSON.stringify([ids, errorPatterns]);
    const cached = cache.get(range);
    if (cached?.key === key && cached.expiresAt > requestedAt) return cached.result;
    if (cached?.expiresAt === Infinity) {
      // Let the old snapshot finish, then coalesce reads for the new one.
      const reload = () => getSeries(range);
      return cached.result.then(reload, reload);
    }

    const result = load(range, requestedAt, ids, errorPatterns).then((series) => {
      entry.expiresAt = now() + minute;
      return series;
    }, (error) => {
      cache.delete(range);
      throw error;
    });
    const entry = { key, expiresAt: Infinity, result };
    cache.set(range, entry);
    return result;
  };
}
