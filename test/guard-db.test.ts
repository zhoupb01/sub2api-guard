import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGuardDb } from "../src/guard-db";
import type { DecisionRecord } from "../src/web/store";

function decision(id: number, dryRun: boolean): DecisionRecord {
  return {
    ts: "2026-11-19T12:00:00.000Z",
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
    dryRun,
  };
}

async function withTempDatabase(check: (path: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-guard-db-"));
  try {
    check(join(directory, "guard.db"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("returns the newest 200 decisions for the current mode in newest-first order", () => withTempDatabase((path) => {
  const dry = openGuardDb(path, true);
  const live = openGuardDb(path, false);
  try {
    for (let id = 1; id <= 205; id += 1) dry.decisions.append(decision(id, true));
    live.decisions.append(decision(999, false));

    const loaded = dry.decisions.recent(200);
    expect(loaded).toHaveLength(200);
    expect(loaded.map(({ id }) => id)).toEqual(Array.from({ length: 200 }, (_, index) => 205 - index));
    expect(live.decisions.recent(200)).toEqual([decision(999, false)]);
  } finally {
    live.close();
    dry.close();
  }
}));

test("returns no decisions before any are written", () => {
  const { decisions, close } = openGuardDb(":memory:", true);
  try {
    expect(decisions.recent(200)).toEqual([]);
  } finally {
    close();
  }
});

test("round-trips adjustment, reopen and manual decisions exactly", () => {
  const db = openGuardDb(":memory:", true);
  const base = {
    ts: "2026-11-19T12:00:00.000Z", id: 1, name: "账号 1", concurrency: 2,
    lastChangeAt: "2026-11-19T00:00:00.000Z", dryRun: true,
  };
  const adjustment = decision(1, true);
  const reopen: DecisionRecord = { ...base, event: "reopen", closedAt: base.lastChangeAt, reopenMinutes: 720 };
  const manual: DecisionRecord = { ...base, event: "manual", field: "loadFactor", from: 3, to: null };
  try {
    db.decisions.append(adjustment);
    db.decisions.append(reopen);
    db.decisions.append(manual);

    expect(db.decisions.recent(3)).toStrictEqual([manual, reopen, adjustment]);
  } finally {
    db.close();
  }
});

test("clears a state field with undefined and preserves omitted fields", () => {
  const { state, close } = openGuardDb(":memory:", true);
  const closedAt = "2026-11-19T00:00:00.000Z";
  const lastFloorPushAt = "2026-11-19T12:00:00.000Z";
  try {
    expect(state.get(1)).toBeUndefined();
    state.set(1, { closedAt, lastFloorPushAt });
    expect(state.get(1)?.closedAt).toBe(closedAt);
    expect(state.get(1)?.lastChangeAt).toBeUndefined();

    state.set(1, { closedAt: undefined });
    expect(state.get(1)?.closedAt).toBeUndefined();
    expect(state.get(1)?.lastFloorPushAt).toBe(lastFloorPushAt);
  } finally {
    close();
  }
});

test("keeps each mode's state and decisions separate after closing and reopening the file", () => withTempDatabase((path) => {
  const dryRecord = decision(1, true);
  const liveRecord = decision(1, false);
  const dryChangeAt = "2026-11-19T12:00:00.000Z";
  const liveChangeAt = "2026-11-19T12:01:00.000Z";
  const first = openGuardDb(path, true);
  try {
    first.state.set(1, { lastChangeAt: dryChangeAt });
    first.decisions.append(dryRecord);
  } finally {
    first.close();
  }

  const live = openGuardDb(path, false);
  const dry = openGuardDb(path, true);
  try {
    expect(live.state.get(1)).toBeUndefined();
    expect(live.decisions.recent(10)).toEqual([]);
    live.state.set(1, { lastChangeAt: liveChangeAt });
    live.decisions.append(liveRecord);

    expect(dry.state.get(1)?.lastChangeAt).toBe(dryChangeAt);
    expect(dry.decisions.recent(10)).toStrictEqual([dryRecord]);
    expect(live.state.get(1)?.lastChangeAt).toBe(liveChangeAt);
    expect(live.decisions.recent(10)).toStrictEqual([liveRecord]);
  } finally {
    dry.close();
    live.close();
  }
}));
