import { expect, test } from "bun:test";
import { decide, decideReopens, recentSince, type AccountSample } from "../src/decide";
import { defaultSettings } from "../src/settings";

const now = Date.parse("2026-11-19T12:00:00Z");
const policy = {
  ...defaultSettings,
  windowMinutes: 10,
  minRequests: 20,
  errorRate: 0.05,
  cooldownMinutes: 10,
  healthyMinutes: 30,
  healthyRate: 0.01,
  minSchedulable: 4,
  reopenMinutes: 720,
  maxConcurrency: 3,
  maxOverrides: {},
  priorityStep: 1,
  errorPatterns: ["overloaded"],
};

function sample(id: number, overrides: Partial<AccountSample> = {}): AccountSample {
  return {
    id,
    concurrency: 3,
    priority: 10,
    priorityBump: 0,
    usable: true,
    recent: { errors: 1, successes: 19 },
    healthy: { errors: 1, successes: 19 },
    ...overrides,
  };
}

test("decreases capacity by one at the request and error-rate thresholds", () => {
  expect(decide(now, [sample(150, { priorityBump: 2 })], policy)).toEqual([
    { accountId: 150, event: "decrease", concurrency: 2, priority: 11, priorityBump: 3 },
  ]);
});

test("reopens a guard-closed account at the exact due boundary", () => {
  const closedAt = "2026-11-19T00:00:00Z";
  expect(decideReopens(now, [{ id: 150, closedAt }], policy.reopenMinutes)).toEqual([
    { accountId: 150, event: "reopen", closedAt },
  ]);
});

test("does not reopen an account before its due time", () => {
  const closedAt = "2026-11-19T00:01:00Z";
  expect(decideReopens(now, [{ id: 150, closedAt }], policy.reopenMinutes)).toEqual([]);
});

test("does not reopen an account without a recorded close", () => {
  expect(decideReopens(now, [{ id: 150 }], policy.reopenMinutes)).toEqual([]);
});

test("closes a bad account at capacity one when four usable accounts remain", () => {
  const accounts = [sample(150, { concurrency: 1 }), ...idleAccounts(4)];
  expect(decide(now, accounts, policy)).toEqual([
    { accountId: 150, event: "close", remainingUsable: 4 },
  ]);
});

const noTraffic = { errors: 0, successes: 0 };
const healthyAtMinimum = { errors: 0, successes: 20 };

function idleAccounts(count: number): AccountSample[] {
  return Array.from({ length: count }, (_, index) =>
    sample(200 + index, { recent: noTraffic, healthy: noTraffic }),
  );
}

test("blocks closing when a temporarily unusable peer leaves fewer than four", () => {
  const [unusable, ...usable] = idleAccounts(4);
  const accounts = [sample(150, { concurrency: 1 }), { ...unusable, usable: false }, ...usable];
  expect(decide(now, accounts, policy)).toEqual([
    { accountId: 150, event: "floor_blocked", remainingUsable: 3 },
  ]);
});

test("closes at most one account per tick even when both closes would fit the floor", () => {
  const accounts = [sample(150, { concurrency: 1 }), sample(151, { concurrency: 1 }), ...idleAccounts(4)];
  expect(decide(now, accounts, policy)).toEqual([
    { accountId: 150, event: "close", remainingUsable: 5 },
  ]);
});

test("increases capacity by one after the healthy period, including at its exact boundary", () => {
  const account = sample(150, {
    concurrency: 2,
    lastChangeAt: "2026-11-19T11:30:00Z",
    recent: { errors: 0, successes: 50 },
    healthy: { errors: 1, successes: 100 },
  });
  expect(decide(now, [account], policy)).toEqual([
    { accountId: 150, event: "increase", concurrency: 3, maxConcurrency: 3, priority: 10, priorityBump: 0 },
  ]);
});

test.each([0, 19])("blocks bumped accounts from recovering with %d requests in the healthy window", (successes) => {
  const traffic = { errors: 0, successes: 20 };
  const belowMax = sample(150, {
    concurrency: 2, priority: 13, priorityBump: 3, recent: traffic, healthy: { errors: 0, successes },
  });
  const atMax = { ...belowMax, id: 151, concurrency: 3 };
  expect(decide(now, [belowMax, atMax], policy)).toEqual([]);
});

test("returns one step on a partial increase at the healthy request minimum", () => {
  const account = sample(150, {
    concurrency: 1, priority: 13, priorityBump: 3, recent: noTraffic, healthy: { errors: 1, successes: 19 },
  });
  expect(decide(now, [account], { ...policy, healthyRate: 0.1 })).toEqual([
    { accountId: 150, event: "increase", concurrency: 2, maxConcurrency: 3, priority: 12, priorityBump: 2 },
  ]);
});

test("at maximum capacity returns the whole bump without making priority negative", () => {
  const account = sample(150, { concurrency: 2, priority: 2, priorityBump: 4, recent: noTraffic, healthy: healthyAtMinimum });
  expect(decide(now, [account], policy)).toEqual([
    { accountId: 150, event: "increase", concurrency: 3, maxConcurrency: 3, priority: 0, priorityBump: 0 },
  ]);
});

test("step zero keeps priority on decrease and partial recovery, then restores it at maximum", () => {
  const settings = { ...policy, priorityStep: 0 };
  const bad = sample(150, { priority: 13, priorityBump: 3 });
  const healthy = { ...bad, recent: noTraffic, healthy: healthyAtMinimum };
  expect(decide(now, [bad], settings)).toEqual([
    { accountId: 150, event: "decrease", concurrency: 2, priority: 13, priorityBump: 3 },
  ]);
  expect(decide(now, [{ ...healthy, concurrency: 1 }], settings)).toEqual([
    { accountId: 150, event: "increase", concurrency: 2, maxConcurrency: 3, priority: 13, priorityBump: 3 },
  ]);
  expect(decide(now, [{ ...healthy, concurrency: 2 }], settings)).toEqual([
    { accountId: 150, event: "increase", concurrency: 3, maxConcurrency: 3, priority: 10, priorityBump: 0 },
  ]);
});

test.each([3, 4])("restores stranded priority at concurrency %d after the healthy period", (concurrency) => {
  const account = sample(150, {
    concurrency, priority: 13, priorityBump: 3, recent: noTraffic, healthy: healthyAtMinimum,
    lastChangeAt: "2026-11-19T11:30:00Z",
  });
  expect(decide(now - 1, [account], policy)).toEqual([]);
  expect(decide(now, [{ ...account, healthy: { errors: 1, successes: 99 } }], policy)).toEqual([]);
  expect(decide(now, [account], { ...policy, priorityStep: 0 })).toEqual([
    { accountId: 150, event: "restore_priority", maxConcurrency: 3, priority: 10, priorityBump: 0 },
  ]);
});

test("clips the recent counting window at the last change", () => {
  expect(recentSince(now, "2026-11-19T11:55:00Z", policy.windowMinutes)).toBe(
    Date.parse("2026-11-19T11:55:00Z"),
  );
  expect(recentSince(now, "2026-11-19T11:40:00Z", policy.windowMinutes)).toBe(
    Date.parse("2026-11-19T11:50:00Z"),
  );
});

test("cooldown blocks another decrease even with enough errors at the new capacity", () => {
  const account = sample(150, { concurrency: 2, lastChangeAt: "2026-11-19T11:51:00Z" });
  expect(decide(now, [account], policy)).toEqual([]);
});

test("does nothing below the minimum request count even when all requests failed", () => {
  const account = sample(150, { recent: { errors: 19, successes: 0 } });
  expect(decide(now, [account], policy)).toEqual([]);
});

test("uses an account override as the maximum", () => {
  const account = sample(150, { concurrency: 2, recent: noTraffic, healthy: noTraffic });
  expect(decide(now, [account], { ...policy, maxOverrides: { "150": 2 } })).toEqual([]);
});

test("leaves owner-set capacity above the maximum alone even when the account is bad", () => {
  expect(decide(now, [sample(150, { concurrency: 4 })], policy)).toEqual([]);
});

test("treats zero traffic with no recorded change or priority bump as healthy", () => {
  const account = sample(150, { concurrency: 1, recent: noTraffic, healthy: noTraffic });
  expect(decide(now, [account], policy)).toEqual([
    { accountId: 150, event: "increase", concurrency: 2, maxConcurrency: 3, priority: 10, priorityBump: 0 },
  ]);
});

test("does not count an error rate equal to the healthy threshold as healthy", () => {
  const account = sample(150, { concurrency: 2, recent: noTraffic, healthy: { errors: 1, successes: 99 } });
  expect(decide(now, [account], policy)).toEqual([]);
});
