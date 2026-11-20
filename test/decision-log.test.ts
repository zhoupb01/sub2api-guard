import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { appendDecision, loadDecisions } from "../src/decision-log";
import type { DecisionRecord } from "../src/web/store";

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function decision(id: number, dryRun: boolean): DecisionRecord {
  return {
    ts: new Date(1_000 + id).toISOString(),
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

test("loads the newest 200 decisions for the current mode in newest-first order", async () => {
  const directory = await mkdtemp(join("/tmp", "sub2api-guard-decision-log-"));
  tempDirectories.push(directory);
  const path = join(directory, "decisions.jsonl");

  for (let id = 1; id <= 205; id += 1) await appendDecision(path, decision(id, true));
  await appendDecision(path, decision(999, false));

  const loaded = await loadDecisions(path, true);
  expect(loaded).toHaveLength(200);
  expect(loaded.map(({ id }) => id)).toEqual(Array.from({ length: 200 }, (_, index) => 205 - index));
  expect(await loadDecisions(path, false)).toEqual([decision(999, false)]);
});

test("treats a missing decision log as empty", async () => {
  const directory = await mkdtemp(join("/tmp", "sub2api-guard-decision-log-"));
  tempDirectories.push(directory);

  expect(await loadDecisions(join(directory, "missing.jsonl"), true)).toEqual([]);
});
