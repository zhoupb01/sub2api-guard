import { maxConcurrencyFor, type Settings } from "./settings";

export interface Traffic {
  errors: number;
  successes: number;
}

export interface AccountSample {
  id: number;
  concurrency: number;
  priority: number;
  priorityBump: number;
  usable: boolean;
  lastChangeAt?: string;
  recent: Traffic;
  healthy: Traffic;
}

export interface ReopenCandidate {
  id: number;
  closedAt?: string;
}

type PriorityAdjustment = { priority: number; priorityBump: number };

export type Decision = { accountId: number } & (
  | ({ event: "decrease"; concurrency: number } & PriorityAdjustment)
  | ({ event: "increase"; concurrency: number; maxConcurrency: number } & PriorityAdjustment)
  | ({ event: "restore_priority"; maxConcurrency: number } & PriorityAdjustment)
  | { event: "close"; remainingUsable: number }
  | { event: "floor_blocked"; remainingUsable: number }
  | { event: "reopen"; closedAt: string }
);

export const minute = 60_000;

export function recentSince(now: number, lastChangeAt: string | undefined, windowMinutes: number): number {
  const windowStart = now - windowMinutes * minute;
  return lastChangeAt === undefined ? windowStart : Math.max(windowStart, Date.parse(lastChangeAt));
}

export function trafficStats({ errors, successes }: Traffic) {
  const total = errors + successes;
  return { errors, successes, total, rate: total === 0 ? 0 : errors / total };
}

export type AdjustmentDecision = Exclude<Decision, { event: "reopen" }>;
export type ReopenDecision = Extract<Decision, { event: "reopen" }>;

export function decideReopens(
  now: number,
  candidates: readonly ReopenCandidate[],
  reopenMinutes: number,
): ReopenDecision[] {
  const decisions: ReopenDecision[] = [];
  for (const candidate of candidates) {
    if (candidate.closedAt !== undefined && now - Date.parse(candidate.closedAt) >= reopenMinutes * minute) {
      decisions.push({ accountId: candidate.id, event: "reopen", closedAt: candidate.closedAt });
    }
  }
  return decisions;
}

export function decide(now: number, samples: readonly AccountSample[], policy: Settings): AdjustmentDecision[] {
  const decisions: AdjustmentDecision[] = [];
  const usableAccounts = samples.filter((account) => account.usable).length;
  let closePlanned = false;
  for (const account of samples) {
    const { id, concurrency, priority, priorityBump } = account;
    const max = maxConcurrencyFor(policy, id);

    const age = account.lastChangeAt === undefined ? Infinity : now - Date.parse(account.lastChangeAt);
    const { total, rate } = trafficStats(account.recent);
    const { total: healthyTotal, rate: healthyRate } = trafficStats(account.healthy);
    if (concurrency <= max && age >= policy.cooldownMinutes * minute && total >= policy.minRequests && rate >= policy.errorRate) {
      if (concurrency > 1) {
        decisions.push({
          accountId: id, event: "decrease", concurrency: concurrency - 1,
          priority: priority + policy.priorityStep, priorityBump: priorityBump + policy.priorityStep,
        });
      } else {
        const remainingUsable = usableAccounts - Number(account.usable);
        if (remainingUsable < policy.minSchedulable) {
          decisions.push({ accountId: id, event: "floor_blocked", remainingUsable });
        } else if (!closePlanned) {
          decisions.push({ accountId: id, event: "close", remainingUsable });
          closePlanned = true;
        }
      }
    } else if (
      age >= policy.healthyMinutes * minute &&
      healthyRate < policy.healthyRate &&
      (priorityBump === 0 || healthyTotal >= policy.minRequests)
    ) {
      if (concurrency < max) {
        const nextConcurrency = concurrency + 1;
        const giveBack = nextConcurrency === max ? priorityBump : Math.min(policy.priorityStep, priorityBump);
        decisions.push({
          accountId: id, event: "increase", concurrency: nextConcurrency, maxConcurrency: max,
          priority: Math.max(0, priority - giveBack), priorityBump: priorityBump - giveBack,
        });
      } else if (priorityBump > 0) {
        decisions.push({
          accountId: id, event: "restore_priority", maxConcurrency: max,
          priority: Math.max(0, priority - priorityBump), priorityBump: 0,
        });
      }
    }
  }
  return decisions;
}
