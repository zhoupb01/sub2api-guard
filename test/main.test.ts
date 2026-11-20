import { expect, test } from "bun:test";
import { openGuardDb, type GuardDb } from "../src/guard-db";
import { createGuard } from "../src/main";
import { defaultSettings } from "../src/settings";
import { openAdminApi } from "../src/sub2api";

const tickAt = Date.parse("2026-11-19T12:00:00.000Z");
const upstreamAccount = { id: 1, name: "账号 1", concurrency: 3, priority: 10, loadFactor: null, usable: true };
const idle = new Map();
const errors = new Map([[1, { accountId: 1, recent: 1, healthy: 1 }]]);
const successes = new Map([[1, { accountId: 1, recent: 19, healthy: 19 }]]);
const healthySuccesses = new Map([[1, { accountId: 1, recent: 0, healthy: 20 }]]);

async function withGuardDb(dryRun: boolean, check: (guardDb: GuardDb) => Promise<void>) {
  const guardDb = openGuardDb(":memory:", dryRun);
  try {
    await check(guardDb);
  } finally {
    guardDb.close();
  }
}

test("a queued settings save takes effect on the next tick", () => withGuardDb(true, async (guardDb) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const patternReads: string[][] = [];
  const guard = createGuard({
    groupId: 34, dryRun: true, guardDb, now: () => tickAt,
    database: {
      accounts: async () => [upstreamAccount],
      closedAccounts: async () => [],
      traffic: async (_windows: unknown, _healthySince: string, _now: string, patterns: string[]) => {
        patternReads.push(patterns);
        entered.resolve();
        await release.promise;
        return { errors, successes };
      },
    },
  });
  const tick = guard.tick();
  await entered.promise;
  const settings = { ...defaultSettings, maxConcurrency: 2, errorPatterns: ["new"], priorityStep: 2 };
  const save = guard.saveSettings(settings);
  expect(guard.store.status().settings).toEqual(defaultSettings);
  release.resolve();
  await tick;
  await save;

  const after = guard.store.status();
  expect(after.settings).toEqual(settings);
  expect(after.settingsUpdatedAt).toBe("2026-11-19T12:00:00.000Z");
  expect(after.accounts[0]?.maxConcurrency).toBe(2);
  expect(after.decisions[0]).toMatchObject({ event: "decrease", priority: 10, nextPriority: 11 });
  expect(guardDb.settings.get()).toEqual({ value: settings, updatedAt: after.settingsUpdatedAt });
  await guard.tick();
  expect(patternReads).toEqual([defaultSettings.errorPatterns, ["new"]]);
}));

test("dry run shows a simulated priority and restores it on recovery without writing upstream", () => withGuardDb(true, async (guardDb) => {
  let now = tickAt;
  let sick = true;
  const writes: unknown[] = [];
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    writes.push(await request.json());
    return Response.json({ code: 0, data: { success_ids: [1] } });
  } });
  try {
    const guard = createGuard({
      groupId: 34, dryRun: true, guardDb, now: () => now, admin: openAdminApi(upstream.url.href, "test-key"),
      database: {
        accounts: async () => [upstreamAccount],
        closedAccounts: async () => [],
        traffic: async () => sick ? { errors, successes } : { errors: idle, successes: healthySuccesses },
      },
    });
    await guard.tick();
    expect(guardDb.state.get(1)?.priorityBump).toBe(1);
    now += 60_000;
    await guard.tick();
    expect(guard.store.status().accounts[0]).toMatchObject({ concurrency: 2, priority: 11 });
    now = tickAt + 30 * 60_000;
    sick = false;
    await guard.tick();
    expect(guardDb.state.get(1)?.priorityBump).toBe(0);
    now += 60_000;
    await guard.tick();
    expect(guard.store.status().accounts[0]).toMatchObject({ concurrency: 3, priority: 10 });
    expect(writes).toEqual([]);
  } finally {
    upstream.stop(true);
  }
}));

test.each([true, false])("sends concurrency and changed priority together and commits state only on success=%s", (success) => withGuardDb(false, async (guardDb) => {
  const writes: unknown[] = [];
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    writes.push({ path: new URL(request.url).pathname, method: request.method, body: await request.json() });
    return Response.json({ code: 0, data: { success_ids: success ? [1] : [] } });
  } });
  try {
    const guard = createGuard({
      groupId: 34, dryRun: false, guardDb, now: () => tickAt, admin: openAdminApi(upstream.url.href, "test-key"),
      database: {
        accounts: async () => [upstreamAccount],
        closedAccounts: async () => [],
        traffic: async () => ({ errors, successes }),
      },
    });
    await guard.tick();
    expect(writes).toEqual([{
      path: "/api/v1/admin/accounts/bulk-update", method: "POST",
      body: { account_ids: [1], concurrency: 2, priority: 11 },
    }]);
    if (success) expect(guardDb.state.get(1)).toMatchObject({ lastChangeAt: "2026-11-19T12:00:00.000Z", priorityBump: 1 });
    else expect(guardDb.state.get(1)).toBeUndefined();
  } finally {
    upstream.stop(true);
  }
}));

test("restores stranded priority with unchanged concurrency and records healthy stats", () => withGuardDb(false, async (guardDb) => {
  const writes: unknown[] = [];
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    writes.push(await request.json());
    return Response.json({ code: 0, data: { success_ids: [1] } });
  } });
  try {
    guardDb.state.set(1, { priorityBump: 3 });
    const guard = createGuard({
      groupId: 34, dryRun: false, guardDb, now: () => tickAt, admin: openAdminApi(upstream.url.href, "test-key"),
      database: {
        accounts: async () => [{ ...upstreamAccount, concurrency: 4 }],
        closedAccounts: async () => [],
        traffic: async () => ({ errors: idle, successes: healthySuccesses }),
      },
    });
    await guard.tick();
    expect(writes).toEqual([{ account_ids: [1], concurrency: 4, priority: 7 }]);
    expect(guardDb.state.get(1)).toMatchObject({ lastChangeAt: "2026-11-19T12:00:00.000Z", priorityBump: 0 });
    expect(guardDb.decisions.recent(1)[0]).toMatchObject({
      event: "restore_priority", priority: 10, nextPriority: 7, concurrency: 4,
      since: "2026-11-19T11:30:00.000Z", errors: 0, maxConcurrency: 3, healthyMinutes: 30, healthyRate: 0.01,
    });
  } finally {
    upstream.stop(true);
  }
}));
