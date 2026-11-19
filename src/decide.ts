export interface Policy {
  windowMinutes: number;
  minRequests: number;
  errorRate: number;
  cooldownMinutes: number;
  healthyMinutes: number;
  healthyRate: number;
  minSchedulable: number;
  maxConcurrency: number;
  maxOverrides: Record<string, number>;
}

export interface Traffic {
  errors: number;
  successes: number;
}

export interface AccountSample {
  id: number;
  concurrency: number;
  usable: boolean;
  lastChangeAt?: string;
  recent: Traffic;
  healthy: Traffic;
}

export type Decision = { accountId: number } & (
  | { event: "decrease"; concurrency: number }
  | { event: "increase"; concurrency: number; maxConcurrency: number }
  | { event: "close" | "floor_blocked"; remainingUsable: number }
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

export function decide(now: number, samples: readonly AccountSample[], policy: Policy): Decision[] {
  const decisions: Decision[] = [];
  const usableAccounts = samples.filter((account) => account.usable).length;
  let closePlanned = false;
  for (const account of samples) {
    const { id, concurrency } = account;
    const max = policy.maxOverrides[id] ?? policy.maxConcurrency;
    if (concurrency > max) continue;

    const age = account.lastChangeAt === undefined ? Infinity : now - Date.parse(account.lastChangeAt);
    const { total, rate } = trafficStats(account.recent);
    if (age >= policy.cooldownMinutes * minute && total >= policy.minRequests && rate >= policy.errorRate) {
      if (concurrency > 1) {
        decisions.push({ accountId: id, event: "decrease", concurrency: concurrency - 1 });
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
      concurrency < max &&
      age >= policy.healthyMinutes * minute &&
      trafficStats(account.healthy).rate < policy.healthyRate
    ) {
      decisions.push({ accountId: id, event: "increase", concurrency: concurrency + 1, maxConcurrency: max });
    }
  }
  return decisions;
}
