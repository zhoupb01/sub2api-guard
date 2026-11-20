import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { defaultSettings } from "../src/settings";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGuardDb, readProbeConfig } from "../src/guard-db";
import type { DecisionRecord } from "../src/web/store";

function decision(id: number, dryRun: boolean): DecisionRecord {
  return {
    ts: "2026-11-19T12:00:00.000Z",
    event: "decrease",
    id,
    name: `账号 ${id}`,
    concurrency: 2,
    nextConcurrency: 1,
    priority: 10,
    nextPriority: 11,
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

test("reads all decisions since the boundary for the current mode, oldest first", () => withTempDatabase((path) => {
  const dry = openGuardDb(path, true);
  const live = openGuardDb(path, false);
  try {
    const boundary = "2026-11-19T12:00:00.000Z";
    dry.decisions.append({ ...decision(999, true), ts: "2026-11-19T12:01:00.000Z" });
    dry.decisions.append({ ...decision(888, true), ts: "2026-11-19T11:59:59.999Z" });
    for (let id = 1; id <= 205; id++) dry.decisions.append(decision(id, true));
    live.decisions.append(decision(777, false));
    expect(dry.decisions.since(boundary).map(({ id }) => id)).toEqual([
      ...Array.from({ length: 205 }, (_, index) => index + 1), 999,
    ]);
    expect(live.decisions.since(boundary)).toEqual([decision(777, false)]);
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

test("migrates an existing account_state and persists a mode-specific bump", () => withTempDatabase((path) => {
  const old = new Database(path);
  old.run(`
    CREATE TABLE account_state (
      dry_run INTEGER NOT NULL, account_id INTEGER NOT NULL, last_change_at TEXT,
      closed_at TEXT, last_floor_push_at TEXT, PRIMARY KEY (dry_run, account_id)
    );
    INSERT INTO account_state VALUES (1, 1, '2026-11-19T12:00:00.000Z', NULL, NULL);
  `);
  old.close();
  const first = openGuardDb(path, true);
  try {
    expect(first.state.get(1)).toMatchObject({ lastChangeAt: "2026-11-19T12:00:00.000Z", priorityBump: 0 });
    first.state.set(1, { priorityBump: 2 });
    first.state.set(1, { closedAt: "2026-11-19T12:01:00.000Z" });
  } finally {
    first.close();
  }
  const dry = openGuardDb(path, true);
  const live = openGuardDb(path, false);
  try {
    expect(dry.state.get(1)).toMatchObject({ priorityBump: 2, closedAt: "2026-11-19T12:01:00.000Z" });
    expect(live.state.get(1)).toBeUndefined();
  } finally {
    dry.close();
    live.close();
  }
}));

test("defaults settings before the first save and shares saved settings across modes", () => withTempDatabase((path) => {
  const first = openGuardDb(path, true);
  const updatedAt = "2026-11-19T12:00:00.000Z";
  const value = { ...defaultSettings, priorityStep: 0, maxOverrides: { "7": 4 } };
  try {
    expect(first.settings.get()).toEqual({ value: defaultSettings, updatedAt: null });
    first.settings.save(value, updatedAt);
  } finally {
    first.close();
  }
  const live = openGuardDb(path, false);
  try {
    expect(live.settings.get()).toEqual({ value, updatedAt });
  } finally {
    live.close();
  }
}));

test("uses defaults for new fields in old settings and preserves saved values", () => withTempDatabase((path) => {
  const { tickSeconds, barkUrl, probeGroupName, ...previousSettings } = { ...defaultSettings, maxConcurrency: 7 };
  const updatedAt = "2026-11-19T12:00:00.000Z";
  const guardDb = openGuardDb(path, false);
  try {
    expect(readProbeConfig(path).probeGroupName).toBe("账号测试");
    const sqlite = new Database(path);
    try {
      sqlite.run("INSERT INTO settings (id, value, updated_at) VALUES (1, ?, ?)", [JSON.stringify(previousSettings), updatedAt]);
    } finally {
      sqlite.close();
    }
    expect(guardDb.settings.get()).toEqual({ value: { ...defaultSettings, maxConcurrency: 7 }, updatedAt });
    expect(readProbeConfig(path).probeGroupName).toBe("账号测试");
  } finally {
    guardDb.close();
  }
}));

test("persists API keys across opens and shares them across modes", () => withTempDatabase((path) => {
  const updatedAt = "2026-11-19T12:00:00.000Z";
  const dry = openGuardDb(path, true);
  try {
    expect(dry.apiKeys.get()).toEqual({ admin: null, probe: null, updatedAt: null });
    dry.apiKeys.save({ admin: "admin-secret", probe: "probe-secret" }, updatedAt);
  } finally {
    dry.close();
  }
  const live = openGuardDb(path, false);
  try {
    expect(live.apiKeys.get()).toEqual({ admin: "admin-secret", probe: "probe-secret", updatedAt });
  } finally {
    live.close();
  }
}));

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
