import type { DecisionRecord, RecordedAccount, SeriesAccount, SeriesResponse } from "./api";
import { rateOf } from "./format";

export interface BucketPoint {
  start: number;
  successes: number;
  errors: number;
  /** Null when the bucket had no requests, so the line breaks instead of dropping to 0. */
  rate: number | null;
  /** Effective concurrency at the end of the bucket; 0 while closed. */
  concurrency: number;
  events: DecisionRecord[];
}

interface Capacity {
  concurrency: number;
  closed: boolean;
}

const effective = ({ concurrency, closed }: Capacity) => (closed ? 0 : concurrency);

/** The capacity just before a decision, given the capacity right after it. */
function capacityBefore(record: DecisionRecord, after: Capacity): Capacity {
  switch (record.event) {
    case "decrease":
    case "increase":
    case "restore_priority":
      return { concurrency: record.concurrency, closed: false };
    case "close":
      return { concurrency: record.concurrency, closed: false };
    case "reopen":
      return { concurrency: record.concurrency, closed: true };
    case "manual":
      if (record.field === "concurrency") return { ...after, concurrency: record.from as number };
      if (record.field === "schedulable") return { ...after, closed: !(record.from as boolean) };
      return after;
    default:
      return after;
  }
}

export function bucketPoints(series: SeriesResponse, entry: SeriesAccount, account: RecordedAccount): BucketPoint[] {
  const bucketMs = series.bucketMinutes * 60_000;
  // Walk back from the live capacity through the events, newest first.
  const after = new Map<DecisionRecord, Capacity>();
  let capacity: Capacity = { concurrency: account.concurrency, closed: account.closed };
  for (const record of [...entry.events].reverse()) {
    after.set(record, capacity);
    capacity = capacityBefore(record, capacity);
  }

  let eventIndex = 0;
  return entry.buckets.map((bucket) => {
    const start = Date.parse(bucket.start);
    const end = start + bucketMs;
    const events: DecisionRecord[] = [];
    while (eventIndex < entry.events.length && Date.parse(entry.events[eventIndex].ts) < end) {
      const record = entry.events[eventIndex++];
      events.push(record);
      capacity = after.get(record)!;
    }
    return {
      start,
      successes: bucket.successes,
      errors: bucket.errors,
      rate: bucket.successes + bucket.errors === 0 ? null : rateOf(bucket.errors, bucket.successes),
      concurrency: effective(capacity),
      events,
    };
  });
}

export function totals(entry: SeriesAccount | undefined) {
  let successes = 0;
  let errors = 0;
  for (const bucket of entry?.buckets ?? []) {
    successes += bucket.successes;
    errors += bucket.errors;
  }
  return { successes, errors, total: successes + errors, rate: rateOf(errors, successes) };
}
