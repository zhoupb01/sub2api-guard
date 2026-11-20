import { expect, test } from "bun:test";
import { decide, decideReopens, recentSince, type AccountSample } from "../src/decide";

const now = Date.parse("2026-11-19T12:00:00Z");
const policy = {
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
};

function sample(id: number, overrides: Partial<AccountSample> = {}): AccountSample {
  return {
    id,
    concurrency: 3,
    usable: true,
    recent: { errors: 1, successes: 19 },
    healthy: { errors: 1, successes: 19 },
    ...overrides,
  };
}

test("decreases capacity by one at the request and error-rate thresholds", () => {
  expect(decide(now, [sample(150)], policy)).toEqual([
    { accountId: 150, event: "decrease", concurrency: 2 },
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
    { accountId: 150, event: "increase", concurrency: 3, maxConcurrency: 3 },
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

test("treats zero traffic with no recorded change as healthy", () => {
  const account = sample(150, { concurrency: 1, recent: noTraffic, healthy: noTraffic });
  expect(decide(now, [account], policy)).toEqual([
    { accountId: 150, event: "increase", concurrency: 2, maxConcurrency: 3 },
  ]);
});

test("does not count an error rate equal to the healthy threshold as healthy", () => {
  const account = sample(150, { concurrency: 2, recent: noTraffic, healthy: { errors: 1, successes: 99 } });
  expect(decide(now, [account], policy)).toEqual([]);
});
