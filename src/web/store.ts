import { minute, trafficStats, type AccountSample, type Decision, type Policy } from "../decide";

export type TrafficStats = ReturnType<typeof trafficStats>;

export interface TickAccount extends AccountSample {
  name: string;
  since: string;
  closedAt?: string | null;
}

export interface RecordedAccount {
  id: number;
  name: string;
  concurrency: number;
  maxConcurrency: number;
  usable: boolean;
  closed: boolean;
  closedAt: string | null;
  reopenAt: string | null;
  lastChangeAt: string | null;
  recent: { since: string } & TrafficStats;
  healthy: TrafficStats;
}

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
      event: "reopen";
      closedAt: string;
      reopenMinutes: number;
    }
  | {
      event: Exclude<Decision["event"], "reopen">;
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
    }
);

export interface RecordedError {
  ts: string;
  message: string;
}

const decisionLimit = 200;

export function createStatusStore(meta: {
  groupId: number;
  dryRun: boolean;
  policy: Policy;
  decisions?: readonly DecisionRecord[];
}) {
  const rows = new Map<number, RecordedAccount>();
  const decisions: DecisionRecord[] = [...(meta.decisions ?? [])].slice(0, decisionLimit);
  let lastTickAt: string | null = null;
  let lastError: RecordedError | null = null;

  return {
    recordTick({ now, accounts }: { now: string; accounts: readonly TickAccount[] }) {
      rows.clear();
      for (const account of accounts) {
        const closedAt = account.closedAt ?? null;
        rows.set(account.id, {
          id: account.id,
          name: account.name,
          concurrency: account.concurrency,
          maxConcurrency: meta.policy.maxOverrides[account.id] ?? meta.policy.maxConcurrency,
          usable: account.usable,
          closed: closedAt !== null,
          closedAt,
          reopenAt: closedAt === null
            ? null
            : new Date(Date.parse(closedAt) + meta.policy.reopenMinutes * minute).toISOString(),
          lastChangeAt: account.lastChangeAt ?? null,
          recent: { since: account.since, ...trafficStats(account.recent) },
          healthy: trafficStats(account.healthy),
        });
      }
      lastTickAt = now;
      lastError = null;
    },

    addDecision(record: DecisionRecord) {
      decisions.unshift(record);
      if (decisions.length > decisionLimit) decisions.length = decisionLimit;
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
