import { expect, jest, test } from "bun:test";
import { loadConfig } from "../src/config";
import { openGuardDb, type GuardDb } from "../src/guard-db";
import { createGuard } from "../src/main";
import { defaultSettings } from "../src/settings";

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
    groupId: 34, dryRun: true, sub2apiUrl: "", guardDb, now: () => tickAt,
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
    guardDb.apiKeys.save({ admin: "test-key" }, new Date(tickAt).toISOString());
    const guard = createGuard({
      groupId: 34, dryRun: true, sub2apiUrl: upstream.url.href, guardDb, now: () => now,
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

test.each([
  { tickSeconds: 10, dueAfter: 20_000 },
  { tickSeconds: 60, dueAfter: 60_000 },
  { tickSeconds: 120, dueAfter: 120_000 },
])("the next tick is due at $dueAfter ms when saving a $tickSeconds s interval mid-wait", ({ tickSeconds, dueAfter }) => withGuardDb(true, async (guardDb) => {
  jest.useFakeTimers();
  try {
    const guard = createGuard({
      groupId: 34, dryRun: true, sub2apiUrl: "", guardDb,
      database: {
        accounts: async () => [], closedAccounts: async () => [],
        traffic: async () => ({ errors: idle, successes: idle }),
      },
    });
    const startedAt = await guard.tick();
    jest.advanceTimersByTime(5_000); // Time spent inside the tick counts toward the interval.
    let ready = false;
    const wait = guard.waitForNextTick(startedAt).then(() => { ready = true; });
    jest.advanceTimersByTime(15_000);
    expect(ready).toBe(false);
    await guard.saveSettings({ ...defaultSettings, tickSeconds, minRequests: 21 });

    if (dueAfter > 20_000) {
      jest.advanceTimersByTime(dueAfter - 20_000 - 1);
      await Promise.resolve();
      await Promise.resolve();
      expect(ready).toBe(false);
      jest.advanceTimersByTime(1);
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(true);
    await wait;
    expect(await guard.tick()).toBe(startedAt + dueAfter);
  } finally {
    jest.useRealTimers();
  }
}));

test.each([false, true])("uses the Bark URL saved after startup only in real mode (dryRun=%s)", (dryRun) => withGuardDb(dryRun, async (guardDb) => {
  const pushes: unknown[] = [];
  const bark = Bun.serve({ port: 0, async fetch(request) {
    pushes.push({ path: new URL(request.url).pathname, body: await request.json() });
    return new Response(null, { status: 204 });
  } });
  try {
    guardDb.apiKeys.save({ admin: "test-key" }, new Date(tickAt).toISOString());
    const guard = createGuard({
      groupId: 34, dryRun, sub2apiUrl: "", guardDb, now: () => tickAt,
      database: {
        accounts: async () => [{ ...upstreamAccount, concurrency: 1 }],
        closedAccounts: async () => [],
        traffic: async () => ({ errors, successes }),
      },
    });
    await guard.tick();
    expect(pushes).toEqual([]);
    await guard.saveSettings({ ...defaultSettings, barkUrl: new URL("/device", bark.url).href });
    await guard.tick();
    expect(pushes).toEqual(dryRun ? [] : [{
      path: "/device",
      body: { title: "保留调度 #1 账号 1", body: expect.any(String), group: "sub2api" },
    }]);
  } finally {
    bark.stop(true);
  }
}));

test("real-mode config loads before an admin key has been set", () => {
  expect(loadConfig({ DATABASE_URL: "postgres://unused", DRY_RUN: "0" }).dryRun).toBe(false);
});

test("real ticks pause without an admin key and use queued key changes on the next tick", () => withGuardDb(false, async (guardDb) => {
  const keysUsed: (string | null)[] = [];
  const upstream = Bun.serve({ port: 0, fetch(request) {
    keysUsed.push(request.headers.get("x-api-key"));
    return Response.json({ code: 0, data: { success_ids: [1] } });
  } });
  let now = tickAt;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const guard = createGuard({
      groupId: 34, dryRun: false, sub2apiUrl: upstream.url.href, guardDb, now: () => now,
      database: {
        accounts: async () => [upstreamAccount],
        closedAccounts: async () => [],
        traffic: async () => {
          if (now > tickAt) {
            entered.resolve();
            await release.promise;
          }
          return { errors, successes };
        },
      },
    });
    const closedAt = "2026-11-19T00:00:00.000Z";
    guardDb.state.set(1, { closedAt });
    await guard.tick();
    expect(guard.store.status()).toMatchObject({
      lastError: { ts: "2026-11-19T12:00:00.000Z", message: "实跑模式需要先在设置页填 Admin API Key" },
      decisions: [],
    });
    expect(guardDb.state.get(1)?.closedAt).toBe(closedAt);
    expect(guardDb.decisions.recent(10)).toEqual([]);
    expect(keysUsed).toEqual([]);

    await guard.saveApiKeys({ admin: "first-admin-key" });
    now += 60_000;
    const tick = guard.tick();
    await entered.promise;
    const save = guard.saveApiKeys({ admin: "next-admin-key" });
    await Promise.resolve();
    expect(guardDb.apiKeys.get().admin).toBe("first-admin-key");
    release.resolve();
    await tick;
    await save;
    expect(guard.store.status().lastError).toBeNull();
    now += 10 * 60_000;
    await guard.tick();
    expect(keysUsed).toEqual(["first-admin-key", "next-admin-key"]);
  } finally {
    release.resolve();
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
    guardDb.apiKeys.save({ admin: "test-key" }, new Date(tickAt).toISOString());
    const guard = createGuard({
      groupId: 34, dryRun: false, sub2apiUrl: upstream.url.href, guardDb, now: () => tickAt,
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
    guardDb.apiKeys.save({ admin: "test-key" }, new Date(tickAt).toISOString());
    const guard = createGuard({
      groupId: 34, dryRun: false, sub2apiUrl: upstream.url.href, guardDb, now: () => tickAt,
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
