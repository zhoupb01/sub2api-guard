import { expect, test } from "bun:test";
import { startStatusServer } from "../src/web/server";
import { createStatusStore, type DecisionRecord, type StatusSnapshot, type TickAccount } from "../src/web/store";

const policy = {
  windowMinutes: 10,
  minRequests: 20,
  errorRate: 0.05,
  cooldownMinutes: 10,
  healthyMinutes: 30,
  healthyRate: 0.01,
  minSchedulable: 4,
  maxConcurrency: 3,
  maxOverrides: {},
};

const tickAt = "2026-11-19T12:00:00.000Z";

function account(id: number, overrides: Partial<TickAccount> = {}): TickAccount {
  return {
    id,
    name: `账号 ${id}`,
    concurrency: 2,
    usable: true,
    since: "2026-11-19T11:50:00.000Z",
    recent: { errors: 3, successes: 37 },
    healthy: { errors: 1, successes: 99 },
    ...overrides,
  };
}

function decreaseDecision(id: number): DecisionRecord {
  return {
    ts: tickAt,
    event: "decrease",
    id,
    name: `账号 ${id}`,
    concurrency: 2,
    nextConcurrency: 1,
    minRequests: 20,
    errorRate: 0.05,
    cooldownMinutes: 10,
    errors: 3,
    successes: 37,
    total: 40,
    rate: 0.075,
    since: "2026-11-19T11:50:00.000Z",
    lastChangeAt: null,
    dryRun: true,
  };
}

function closeDecision(id: number): DecisionRecord {
  return {
    ts: tickAt,
    event: "close",
    id,
    name: `账号 ${id}`,
    concurrency: 1,
    remainingUsable: 4,
    minSchedulable: 4,
    minRequests: 20,
    errorRate: 0.05,
    cooldownMinutes: 10,
    errors: 8,
    successes: 12,
    total: 20,
    rate: 0.4,
    since: "2026-11-19T11:50:00.000Z",
    lastChangeAt: null,
    dryRun: true,
  };
}

test("keeps the 200 newest decisions, newest first", () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  for (let id = 1; id <= 205; id += 1) store.addDecision(decreaseDecision(id));

  const { decisions } = store.status();
  expect(decisions).toHaveLength(200);
  expect(decisions[0]?.id).toBe(205);
  expect(decisions[199]?.id).toBe(6);
});

test("keeps a closed account with its last numbers until it reports again", () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  store.addDecision(closeDecision(1));

  store.recordTick({ now: "2026-11-19T12:01:00.000Z", accounts: [] });
  const [closed] = store.status().accounts;
  expect(closed).toEqual({
    id: 1,
    name: "账号 1",
    concurrency: 2,
    maxConcurrency: 3,
    usable: true,
    closed: true,
    lastChangeAt: null,
    recent: { since: "2026-11-19T11:50:00.000Z", errors: 3, successes: 37, total: 40, rate: 0.075 },
    healthy: { errors: 1, successes: 99, total: 100, rate: 0.01 },
  });

  store.recordTick({ now: "2026-11-19T12:02:00.000Z", accounts: [account(1)] });
  expect(store.status().accounts[0]?.closed).toBe(false);
});

test("serves the snapshot at /api/status", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: false, policy: { ...policy, maxOverrides: { "7": 2 } } });
  store.recordTick({ now: tickAt, accounts: [account(1), account(7, { concurrency: 1 })] });
  store.addDecision(closeDecision(1));

  const server = startStatusServer(store, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    const snapshot = await response.json() as StatusSnapshot;

    expect(response.status).toBe(200);
    expect(snapshot.dryRun).toBe(false);
    expect(snapshot.groupId).toBe(34);
    expect(snapshot.policy).toEqual({ ...policy, maxOverrides: { "7": 2 } });
    expect(snapshot.lastTickAt).toBe(tickAt);
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.accounts.map(({ id, maxConcurrency, closed }) => ({ id, maxConcurrency, closed }))).toEqual([
      { id: 1, maxConcurrency: 3, closed: true },
      { id: 7, maxConcurrency: 2, closed: false },
    ]);
    expect(snapshot.accounts[0]).toEqual({
      id: 1,
      name: "账号 1",
      concurrency: 2,
      maxConcurrency: 3,
      usable: true,
      closed: true,
      lastChangeAt: null,
      recent: { since: "2026-11-19T11:50:00.000Z", errors: 3, successes: 37, total: 40, rate: 0.075 },
      healthy: { errors: 1, successes: 99, total: 100, rate: 0.01 },
    });
    expect(snapshot.decisions).toEqual([closeDecision(1)]);
    expect(typeof snapshot.now).toBe("string");
  } finally {
    server.stop(true);
  }
});

test("reports the latest tick error and clears it on the next tick", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordError("2026-11-19T11:59:00.000Z", "connect ECONNREFUSED");

  const server = startStatusServer(store, 0);
  try {
    const before = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json() as StatusSnapshot;
    expect(before.lastTickAt).toBeNull();
    expect(before.lastError).toEqual({ ts: "2026-11-19T11:59:00.000Z", message: "connect ECONNREFUSED" });

    store.recordTick({ now: tickAt, accounts: [account(1)] });
    const after = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json() as StatusSnapshot;
    expect(after.lastError).toBeNull();
    expect(after.lastTickAt).toBe(tickAt);
  } finally {
    server.stop(true);
  }
});

test("serves the page and rejects unknown paths", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0);
  try {
    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain('<html lang="zh-CN">');

    const missing = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(missing.status).toBe(404);
  } finally {
    server.stop(true);
  }
});
