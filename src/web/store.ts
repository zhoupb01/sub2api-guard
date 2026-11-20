import { minute, trafficStats, type AccountSample, type Decision } from "../decide";
import type { SavedSettings } from "../guard-db";
import { defaultSettings, maxConcurrencyFor } from "../settings";

export type { SeriesResponse } from "../series";
export type { Settings } from "../settings";

export type TrafficStats = ReturnType<typeof trafficStats>;

export interface TickAccount extends AccountSample {
  name: string;
  loadFactor: number | null;
  since: string;
  closed: boolean;
  closedAt: string | null;
}

export interface RecordedAccount {
  id: number;
  name: string;
  concurrency: number;
  priority: number;
  priorityBump: number;
  loadFactor: number | null;
  maxConcurrency: number;
  usable: boolean;
  closed: boolean;
  closedAt: string | null;
  reopenAt: string | null;
  lastChangeAt: string | null;
  recent: { since: string } & TrafficStats;
  healthy: TrafficStats;
}

export type ManualChange =
  | { field: "concurrency"; value: number }
  | { field: "priority"; value: number }
  | { field: "loadFactor"; value: number | null }
  | { field: "schedulable"; value: boolean };

interface DecisionRecordBase {
  ts: string;
  id: number;
  name: string;
  concurrency: number;
  lastChangeAt: string | null;
  dryRun: boolean;
}

export type DecisionRecord = DecisionRecordBase & (
  | {
      event: "manual";
      field: ManualChange["field"];
      from: ManualChange["value"];
      to: ManualChange["value"];
    }
  | {
      event: "reopen";
      closedAt: string;
      reopenMinutes: number;
    }
  | {
      event: Exclude<Decision["event"], "reopen">;
      nextConcurrency?: number;
      // Decisions saved before priority tracking do not have these fields.
      priority?: number;
      nextPriority?: number;
      remainingUsable?: number;
      minSchedulable?: number;
      maxConcurrency?: number;
      minRequests?: number;
      errorRate?: number;
      cooldownMinutes?: number;
      healthyMinutes?: number;
      healthyRate?: number;
      errors: number;
      successes: number;
      total: number;
      rate: number;
      since: string;
    }
);

export interface RecordedError {
  ts: string;
  message: string;
}

const decisionLimit = 200;
type AccountRow = Omit<RecordedAccount, "maxConcurrency" | "reopenAt">;

export function createStatusStore(meta: {
  groupId: number;
  dryRun: boolean;
  settings?: SavedSettings;
  manualEnabled?: boolean;
  probeEnabled?: boolean;
  decisions?: readonly DecisionRecord[];
}) {
  const rows = new Map<number, AccountRow>();
  let settings = meta.settings ?? { value: defaultSettings, updatedAt: null };
  const decisions: DecisionRecord[] = [...(meta.decisions ?? [])].slice(0, decisionLimit);
  let lastTickAt: string | null = null;
  let lastError: RecordedError | null = null;
  const accountIds = () => [...rows.keys()].sort((left, right) => left - right);

  return {
    recordTick({ now, accounts }: { now: string; accounts: readonly TickAccount[] }) {
      rows.clear();
      for (const account of accounts) {
        const { closedAt } = account;
        rows.set(account.id, {
          id: account.id,
          name: account.name,
          concurrency: account.concurrency,
          priority: account.priority,
          priorityBump: account.priorityBump,
          loadFactor: account.loadFactor,
          usable: account.usable,
          closed: account.closed,
          closedAt,
          lastChangeAt: account.lastChangeAt ?? null,
          recent: { since: account.since, ...trafficStats(account.recent) },
          healthy: trafficStats(account.healthy),
        });
      }
      lastTickAt = now;
      lastError = null;
    },

    getAccount(id: number) {
      return rows.get(id);
    },

    updateAccount(account: AccountRow, changes: Partial<Pick<AccountRow,
      "concurrency" | "priority" | "priorityBump" | "loadFactor" | "closed" | "closedAt" | "lastChangeAt"
    >>) {
      const updated = { ...account, ...changes };
      rows.set(account.id, updated);
      return updated;
    },

    addDecision(record: DecisionRecord) {
      decisions.unshift(record);
      if (decisions.length > decisionLimit) decisions.length = decisionLimit;
    },

    recordError(ts: string, message: string) {
      lastError = { ts, message };
    },

    getSettings() {
      return settings;
    },

    setSettings(saved: SavedSettings) {
      settings = saved;
    },

    accountIds,

    status() {
      return {
        now: new Date().toISOString(),
        dryRun: meta.dryRun,
        manualEnabled: meta.manualEnabled ?? false,
        probeEnabled: meta.probeEnabled ?? false,
        groupId: meta.groupId,
        settings: settings.value,
        settingsUpdatedAt: settings.updatedAt,
        lastTickAt,
        lastError,
        accounts: accountIds().map((id): RecordedAccount => {
          const row = rows.get(id)!;
          return {
            ...row,
            maxConcurrency: maxConcurrencyFor(settings.value, id),
            reopenAt: row.closedAt === null ? null
              : new Date(Date.parse(row.closedAt) + settings.value.reopenMinutes * minute).toISOString(),
          };
        }),
        decisions: [...decisions],
      };
    },
  };
}

export type StatusStore = ReturnType<typeof createStatusStore>;
export type StatusSnapshot = ReturnType<StatusStore["status"]>;
