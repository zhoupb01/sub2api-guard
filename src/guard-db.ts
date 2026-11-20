import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { defaultSettings, type Settings } from "./settings";
import type { DecisionRecord } from "./web/store";

type DecisionRow = Pick<DecisionRecord, "ts" | "event" | "id" | "name" | "concurrency" | "lastChangeAt"> & {
  details: string;
};

export interface AccountState {
  lastChangeAt: string | undefined;
  closedAt: string | undefined;
  lastFloorPushAt: string | undefined;
  priorityBump: number;
}

type StateRow = { [Field in keyof AccountState]: Exclude<AccountState[Field], undefined> | null } & { priorityBump: number };

export interface SavedSettings {
  value: Settings;
  updatedAt: string | null;
}

export type ApiKeyUpdate = {
  admin?: string | null;
  probe?: string | null;
};

type SavedApiKeys = Required<ApiKeyUpdate> & { updatedAt: string | null };
const unsetApiKeys: SavedApiKeys = { admin: null, probe: null, updatedAt: null };

function getApiKeys(database: Database): SavedApiKeys {
  return database.query<SavedApiKeys, []>(
    "SELECT admin_api_key AS admin, probe_api_key AS probe, updated_at AS updatedAt FROM api_keys WHERE id = 1",
  ).get() ?? { ...unsetApiKeys };
}

function getSettings(database: Database): SavedSettings {
  const row = database.query<{ value: string; updatedAt: string }, []>(
    "SELECT value, updated_at AS updatedAt FROM settings WHERE id = 1",
  ).get();
  return row ? { value: { ...defaultSettings, ...JSON.parse(row.value) }, updatedAt: row.updatedAt }
    : { value: defaultSettings, updatedAt: null };
}

export function readProbeConfig(path: string) {
  const { probeGroupName } = defaultSettings;
  if (!existsSync(path)) return { ...unsetApiKeys, probeGroupName };
  const database = new Database(path, { readonly: true });
  try {
    const hasTable = database.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    const keys = hasTable.get("api_keys") ? getApiKeys(database) : unsetApiKeys;
    const settings = hasTable.get("settings") ? getSettings(database).value : defaultSettings;
    return { ...keys, probeGroupName: settings.probeGroupName };
  } finally {
    database.close();
  }
}

export interface GuardDb {
  state: {
    get(id: number): AccountState | undefined;
    set(id: number, update: Partial<AccountState>): void;
  };
  decisions: {
    append(record: DecisionRecord): void;
    recent(limit: number): DecisionRecord[];
    since(from: string): DecisionRecord[];
  };
  settings: {
    get(): SavedSettings;
    save(value: Settings, updatedAt: string): void;
  };
  apiKeys: {
    get(): SavedApiKeys;
    save(update: ApiKeyUpdate, updatedAt: string): void;
  };
  close(): void;
}

export function openGuardDb(path: string, dryRun: boolean): GuardDb {
  const database = new Database(path);
  database.run(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS account_state (
      dry_run INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      last_change_at TEXT,
      closed_at TEXT,
      last_floor_push_at TEXT,
      priority_bump INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (dry_run, account_id)
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      dry_run INTEGER NOT NULL,
      event TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      account_name TEXT NOT NULL,
      concurrency INTEGER NOT NULL,
      last_change_at TEXT,
      details TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decisions_by_mode ON decisions (dry_run, id);
    CREATE INDEX IF NOT EXISTS decisions_by_mode_time ON decisions (dry_run, ts, id);
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      admin_api_key TEXT,
      probe_api_key TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  if (!database.query<{ name: string }, []>("PRAGMA table_info(account_state)").all().some(({ name }) => name === "priority_bump")) {
    database.run("ALTER TABLE account_state ADD COLUMN priority_bump INTEGER NOT NULL DEFAULT 0");
  }

  const getState = database.query<StateRow, [boolean, number]>(`
    SELECT last_change_at AS lastChangeAt, closed_at AS closedAt,
           last_floor_push_at AS lastFloorPushAt, priority_bump AS priorityBump
    FROM account_state WHERE dry_run = ? AND account_id = ?
  `);
  const setState = database.query(`
    INSERT INTO account_state (dry_run, account_id, last_change_at, closed_at, last_floor_push_at, priority_bump)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (dry_run, account_id) DO UPDATE SET
      last_change_at = CASE WHEN ? THEN excluded.last_change_at ELSE account_state.last_change_at END,
      closed_at = CASE WHEN ? THEN excluded.closed_at ELSE account_state.closed_at END,
      last_floor_push_at = CASE WHEN ? THEN excluded.last_floor_push_at ELSE account_state.last_floor_push_at END,
      priority_bump = CASE WHEN ? THEN excluded.priority_bump ELSE account_state.priority_bump END
  `);
  const insertDecision = database.query(`
    INSERT INTO decisions (ts, dry_run, event, account_id, account_name, concurrency, last_change_at, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectDecisions = `
    SELECT ts, event, account_id AS id, account_name AS name, concurrency, last_change_at AS lastChangeAt, details
    FROM decisions WHERE dry_run = ?
  `;
  const recentDecisions = database.query<DecisionRow, [boolean, number]>(
    selectDecisions + " ORDER BY decisions.id DESC LIMIT ?",
  );
  const decisionsSince = database.query<DecisionRow, [boolean, string]>(
    selectDecisions + " AND ts >= ? ORDER BY ts, decisions.id",
  );
  const unpackDecision = ({ details, ...record }: DecisionRow): DecisionRecord => ({
    ...JSON.parse(details), ...record, dryRun,
  });
  const saveSettings = database.query(`
    INSERT INTO settings (id, value, updated_at) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const saveApiKeys = database.query(`
    INSERT INTO api_keys (id, admin_api_key, probe_api_key, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      admin_api_key = CASE WHEN ? THEN excluded.admin_api_key ELSE api_keys.admin_api_key END,
      probe_api_key = CASE WHEN ? THEN excluded.probe_api_key ELSE api_keys.probe_api_key END,
      updated_at = excluded.updated_at
  `);

  return {
    state: {
      get(id) {
        const row = getState.get(dryRun, id);
        if (!row) return undefined;
        return {
          lastChangeAt: row.lastChangeAt ?? undefined,
          closedAt: row.closedAt ?? undefined,
          lastFloorPushAt: row.lastFloorPushAt ?? undefined,
          priorityBump: row.priorityBump,
        };
      },
      set(id, update) {
        setState.run(
          dryRun, id, update.lastChangeAt ?? null, update.closedAt ?? null, update.lastFloorPushAt ?? null,
          update.priorityBump ?? 0,
          "lastChangeAt" in update, "closedAt" in update, "lastFloorPushAt" in update, update.priorityBump !== undefined,
        );
      },
    },
    decisions: {
      append(record) {
        const { ts, dryRun: _dryRun, event, id, name, concurrency, lastChangeAt, ...details } = record;
        insertDecision.run(ts, dryRun, event, id, name, concurrency, lastChangeAt, JSON.stringify(details));
      },
      recent(limit) {
        return recentDecisions.all(dryRun, limit).map(unpackDecision);
      },
      since(from) {
        return decisionsSince.all(dryRun, from).map(unpackDecision);
      },
    },
    settings: {
      get: () => getSettings(database),
      save(value, updatedAt) {
        saveSettings.run(JSON.stringify(value), updatedAt);
      },
    },
    apiKeys: {
      get: () => getApiKeys(database),
      save({ admin, probe }, updatedAt) {
        saveApiKeys.run(admin ?? null, probe ?? null, updatedAt, admin !== undefined, probe !== undefined);
      },
    },
    close: () => database.close(),
  };
}
