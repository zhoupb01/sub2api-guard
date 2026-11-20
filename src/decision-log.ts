import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DecisionRecord } from "./web/store";

const decisionLimit = 200;

export async function loadDecisions(path: string, dryRun: boolean): Promise<DecisionRecord[]> {
  const file = Bun.file(path);
  if (!await file.exists()) return [];
  const records = (await file.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DecisionRecord)
    .filter((record) => record.dryRun === dryRun);
  return records.slice(-decisionLimit).reverse();
}

export async function appendDecision(path: string, record: DecisionRecord) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`);
}
