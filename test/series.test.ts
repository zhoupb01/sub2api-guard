import { expect, test } from "bun:test";
import { createSeries, type SeriesQuery } from "../src/series";
import { openGuardDb } from "../src/guard-db";
import { createStatusStore, type DecisionRecord, type TickAccount } from "../src/web/store";

const now = "2026-11-19T12:03:14.123Z";
const time = Date.parse(now);
const traffic = { errors: 0, successes: 0 };
const account: TickAccount = {
  id: 2, name: "账号 2", concurrency: 2, priority: 10, priorityBump: 0, usable: true,
  recent: traffic, healthy: traffic, loadFactor: null, since: now, closed: false, closedAt: null,
};

function event(ts: string, id: number, dryRun = true): DecisionRecord {
  return { ts, id, dryRun, event: "manual", concurrency: 2, name: `账号 ${id}`, lastChangeAt: null,
    field: "priority", from: 12, to: 10 };
}

test("aligns the last partial bucket to UTC and zero-fills all accounts from the latest tick", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  store.recordTick({ now, accounts: [account, { ...account, id: 1, closed: true }] });
  const db = openGuardDb(":memory:", true);
  try {
    const first = event("2026-11-19T11:05:00.000Z", 1);
    const later = event("2026-11-19T11:15:00.000Z", 1);
    db.decisions.append(later);
    db.decisions.append(first);
    db.decisions.append(event("2026-11-19T11:04:59.999Z", 1));
    const query: SeriesQuery = async (window, ids, patterns) => {
      expect(window).toEqual({ from: first.ts, to: now, bucketMinutes: 5 });
      expect(ids).toEqual([1, 2]);
      expect(patterns).toEqual(["overloaded", "Concurrency limit exceeded for account"]);
      return {
        successes: [{ accountId: 1, start: Date.parse(first.ts), count: 5 }],
        errors: [{ accountId: 1, start: Date.parse(first.ts), count: 2 }],
      };
    };
    const series = await createSeries(store, db.decisions, query, () => time)("1h");
    expect(series).toMatchObject({ range: "1h", from: first.ts, to: now, bucketMinutes: 5 });
    expect(series.accounts.map(({ id, buckets }) => [id, buckets.length])).toEqual([[1, 12], [2, 12]]);
    expect(series.accounts[0]?.buckets[0]).toEqual({ start: first.ts, successes: 5, errors: 2 });
    expect(series.accounts[0]?.buckets[11]).toEqual({ start: "2026-11-19T12:00:00.000Z", successes: 0, errors: 0 });
    expect(series.accounts[1]?.buckets.every(({ successes, errors }) => successes === 0 && errors === 0)).toBe(true);
    expect(series.accounts.map(({ events }) => events)).toEqual([[first, later], []]);
  } finally {
    db.close();
  }
});

test.each([
  ["24h", 60, 24, "2026-11-18T13:00:00.000Z"],
  ["7d", 360, 28, "2026-11-12T18:00:00.000Z"],
] as const)("builds the %s range with the expected width and bucket count", async (range, bucketMinutes, length, from) => {
  const store = createStatusStore({ groupId: 34, dryRun: false });
  store.recordTick({ now, accounts: [account] });
  const series = await createSeries(store, { since: () => [] }, async () => ({ successes: [], errors: [] }), () => time)(range);
  expect(series).toMatchObject({ range, from, to: now, bucketMinutes });
  expect(series.accounts[0]?.buckets).toHaveLength(length);
  expect(series.accounts[0]?.buckets.at(-1)?.start).toBe("2026-11-19T12:00:00.000Z");
});

test("shares in-flight series reads and caches each range for 60 seconds", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: false });
  store.recordTick({ now, accounts: [account] });
  const gate = Promise.withResolvers<void>();
  let clock = time;
  let calls = 0;
  const series = createSeries(store, { since: () => [] }, async () => {
    calls++;
    await gate.promise;
    return { successes: [], errors: [] };
  }, () => clock);
  const first = series("1h");
  const concurrent = series("1h");
  const other = series("24h");
  gate.resolve();
  const [initial, joined, day] = await Promise.all([first, concurrent, other]);
  expect(joined).toBe(initial);
  expect(day.range).toBe("24h");
  expect(calls).toBe(2);
  clock += 59_999;
  expect(await series("1h")).toBe(initial);
  clock++;
  expect((await series("1h")).to).toBe("2026-11-19T12:04:14.123Z");
  expect(calls).toBe(3);
});

test("uses live patterns and account membership even before the previous result expires", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: false });
  store.recordTick({ now, accounts: [account] });
  const requests: { ids: number[]; patterns: string[] }[] = [];
  const series = createSeries(store, { since: () => [] }, async (_window, ids, patterns) => {
    requests.push({ ids, patterns });
    return { successes: [], errors: [] };
  }, () => time);
  expect((await series("1h")).accounts.map(({ id }) => id)).toEqual([2]);
  store.setSettings({ value: { ...store.getSettings().value, errorPatterns: ["different"] }, updatedAt: now });
  expect((await series("1h")).accounts.map(({ id }) => id)).toEqual([2]);
  store.recordTick({ now, accounts: [{ ...account, id: 3 }] });
  expect((await series("1h")).accounts.map(({ id }) => id)).toEqual([3]);
  expect(requests).toEqual([
    { ids: [2], patterns: ["overloaded", "Concurrency limit exceeded for account"] },
    { ids: [2], patterns: ["different"] },
    { ids: [3], patterns: ["different"] },
  ]);
});

test("waits for a same-range read before querying with newly saved patterns", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: false });
  store.recordTick({ now, accounts: [account] });
  const gate = Promise.withResolvers<void>();
  const patternReads: string[][] = [];
  const series = createSeries(store, { since: () => [] }, async (_window, _ids, patterns) => {
    patternReads.push(patterns);
    await gate.promise;
    return { successes: [], errors: [] };
  }, () => time);
  const first = series("1h");
  store.setSettings({ value: { ...store.getSettings().value, errorPatterns: ["different"] }, updatedAt: now });
  const second = series("1h");
  const third = series("1h");
  const startedBeforeRelease = patternReads.length;
  gate.resolve();
  const [, updated, joined] = await Promise.all([first, second, third]);
  expect(startedBeforeRelease).toBe(1);
  expect(patternReads).toEqual([["overloaded", "Concurrency limit exceeded for account"], ["different"]]);
  expect(joined).toBe(updated);
});
