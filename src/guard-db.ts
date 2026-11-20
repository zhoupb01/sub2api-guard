import { Database } from "bun:sqlite";
import type { DecisionRecord } from "./web/store";

type DecisionRow = Pick<DecisionRecord, "ts" | "event" | "id" | "name" | "concurrency" | "lastChangeAt"> & {
  details: string;
};

export interface AccountState {
  lastChangeAt: string | undefined;
  closedAt: string | undefined;
  lastFloorPushAt: string | undefined;
}

type StateRow = { [Field in keyof AccountState]: string | null };

export interface GuardDb {
  state: {
    get(id: number): AccountState | undefined;
    set(id: number, update: Partial<AccountState>): void;
  };
  decisions: {
    append(record: DecisionRecord): void;
    recent(limit: number): DecisionRecord[];
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
  `);

  const getState = database.query<StateRow, [boolean, number]>(`
    SELECT last_change_at AS lastChangeAt, closed_at AS closedAt, last_floor_push_at AS lastFloorPushAt
    FROM account_state WHERE dry_run = ? AND account_id = ?
  `);
  const setState = database.query(`
    INSERT INTO account_state (dry_run, account_id, last_change_at, closed_at, last_floor_push_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (dry_run, account_id) DO UPDATE SET
      last_change_at = CASE WHEN ? THEN excluded.last_change_at ELSE account_state.last_change_at END,
      closed_at = CASE WHEN ? THEN excluded.closed_at ELSE account_state.closed_at END,
      last_floor_push_at = CASE WHEN ? THEN excluded.last_floor_push_at ELSE account_state.last_floor_push_at END
  `);
  const insertDecision = database.query(`
    INSERT INTO decisions (ts, dry_run, event, account_id, account_name, concurrency, last_change_at, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const recentDecisions = database.query<DecisionRow, [boolean, number]>(`
    SELECT ts, event, account_id AS id, account_name AS name, concurrency, last_change_at AS lastChangeAt, details
    FROM decisions WHERE dry_run = ? ORDER BY decisions.id DESC LIMIT ?
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
        };
      },
      set(id, update) {
        setState.run(
          dryRun, id, update.lastChangeAt ?? null, update.closedAt ?? null, update.lastFloorPushAt ?? null,
          "lastChangeAt" in update, "closedAt" in update, "lastFloorPushAt" in update,
        );
      },
    },
    decisions: {
      append(record) {
        const { ts, dryRun: _dryRun, event, id, name, concurrency, lastChangeAt, ...details } = record;
        insertDecision.run(ts, dryRun, event, id, name, concurrency, lastChangeAt, JSON.stringify(details));
      },
      recent(limit) {
        return recentDecisions.all(dryRun, limit).map(({ details, ...record }) => ({
          ...JSON.parse(details), ...record, dryRun,
        }));
      },
    },
    close: () => database.close(),
  };
}
