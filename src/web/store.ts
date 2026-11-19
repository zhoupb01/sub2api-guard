import { trafficStats, type AccountSample, type Decision, type Policy } from "../decide";

export type TrafficStats = ReturnType<typeof trafficStats>;

export interface TickAccount extends AccountSample {
  name: string;
  since: string;
}

export interface RecordedAccount {
  id: number;
  name: string;
  concurrency: number;
  maxConcurrency: number;
  usable: boolean;
  closed: boolean;
  lastChangeAt: string | null;
  recent: { since: string } & TrafficStats;
  healthy: TrafficStats;
}

export interface DecisionRecord {
  ts: string;
  event: Decision["event"];
  id: number;
  name: string;
  concurrency: number;
  nextConcurrency?: number;
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
  lastChangeAt: string | null;
  dryRun: boolean;
}

export interface RecordedError {
  ts: string;
  message: string;
}

const decisionLimit = 200;

export function createStatusStore(meta: { groupId: number; dryRun: boolean; policy: Policy }) {
  const rows = new Map<number, RecordedAccount>();
  const decisions: DecisionRecord[] = [];
  let lastTickAt: string | null = null;
  let lastError: RecordedError | null = null;

  return {
    recordTick({ now, accounts }: { now: string; accounts: readonly TickAccount[] }) {
      const present = new Set<number>();
      for (const account of accounts) {
        present.add(account.id);
        rows.set(account.id, {
          id: account.id,
          name: account.name,
          concurrency: account.concurrency,
          maxConcurrency: meta.policy.maxOverrides[account.id] ?? meta.policy.maxConcurrency,
          usable: account.usable,
          closed: false,
          lastChangeAt: account.lastChangeAt ?? null,
          recent: { since: account.since, ...trafficStats(account.recent) },
          healthy: trafficStats(account.healthy),
        });
      }
      // Closed accounts leave the query. Keep the ones the guard closed, drop the rest.
      for (const [id, account] of rows) {
        if (!present.has(id) && !account.closed) rows.delete(id);
      }
      lastTickAt = now;
      lastError = null;
    },

    addDecision(record: DecisionRecord) {
      decisions.unshift(record);
      if (decisions.length > decisionLimit) decisions.length = decisionLimit;
      if (record.event !== "close") return;
      const account = rows.get(record.id);
      if (account) account.closed = true;
    },

    recordError(ts: string, message: string) {
      lastError = { ts, message };
    },

    status() {
      return {
        now: new Date().toISOString(),
        dryRun: meta.dryRun,
        groupId: meta.groupId,
        policy: meta.policy,
        lastTickAt,
        lastError,
        accounts: [...rows.values()].sort((left, right) => left.id - right.id),
        decisions: [...decisions],
      };
    },
  };
}

export type StatusStore = ReturnType<typeof createStatusStore>;
export type StatusSnapshot = ReturnType<StatusStore["status"]>;
