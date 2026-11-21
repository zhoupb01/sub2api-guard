import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { defaultGuardDbPath } from "./config";
import { readProbeConfig } from "./guard-db";
import { openAdminApi } from "./sub2api";

type ProbeOptions = {
  baseUrl: string;
  adminApiKey: string;
  probeApiKey: string;
  groupName: string;
  accountIds: number[];
  model: string;
  prompt: string;
  repeat: number;
  log(message: string): void;
  onResult?(result: ProbeResult): void;
};

type RequestResult = {
  status?: number;
  firstTokenSeconds?: number;
  totalSeconds: number;
  output: string;
  error?: string;
};

export type ProbeResult = RequestResult & { accountId: number; name: string; requestNumber: number };

type ResponseEvent = {
  type?: string;
  delta?: string;
  message?: string;
  error?: { message?: string };
  response?: { error?: { message?: string } };
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function sendProbe(options: ProbeOptions, signal: AbortSignal) {
  const { baseUrl, probeApiKey, model, prompt } = options;
  const start = performance.now();
  const result: RequestResult = { totalSeconds: 0, output: "" };
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${probeApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: prompt, stream: true }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    });
    result.status = response.status;
    if (!response.ok) {
      result.error = await response.text() || response.statusText || `HTTP ${response.status}`;
    } else {
      if (!response.body) throw new Error("Response did not include an SSE stream");
      let buffer = "";
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop()!;
        for (const frame of frames) {
          const lines = frame.split(/\r?\n/);
          const data = lines.filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data) as ResponseEvent;
          const type = event.type ?? lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (type === "response.output_text.delta" && event.delta) {
            result.firstTokenSeconds ??= (performance.now() - start) / 1_000;
            result.output += event.delta;
          } else if (type === "error" || type === "response.failed") {
            result.error = event.response?.error?.message ?? event.error?.message ?? event.message ?? type;
          }
        }
      }
    }
  } catch (error) {
    result.error = errorMessage(error);
  }
  result.totalSeconds = (performance.now() - start) / 1_000;
  return result;
}

export async function runProbe(options: ProbeOptions, signal: AbortSignal) {
  const { baseUrl, adminApiKey, probeApiKey, groupName, accountIds, repeat, log, onResult } = options;
  const results: ProbeResult[] = [];
  let exitCode = 0;
  const admin = openAdminApi(baseUrl, adminApiKey);
  signal.throwIfAborted();
  const group = await admin.getOrCreateProbeGroup(groupName);
  signal.throwIfAborted();
  await admin.bindProbeKey(probeApiKey, group.id, signal);

  for (const id of accountIds) {
    if (signal.aborted) break;
    let restoreFailed = false;
    try {
      const account = await admin.getAccount(id);
      signal.throwIfAborted();
      const groupIds = account.group_ids ?? []; // Empty bindings are omitted by the account DTO.
      const originalGroupIds = groupIds.filter((groupId) => groupId !== group.id);
      let opened = false;
      log(`Account ${id} (${account.name}): adding to ${group.name}`);
      try {
        if (!groupIds.includes(group.id)) {
          await admin.setGroups(id, [...originalGroupIds, group.id]);
        }
        signal.throwIfAborted();
        if (!await admin.isOnlyGroupAccount(group.id, id)) {
          throw new Error(`Probe group ${group.id} does not contain exactly account ${id}. Skipping requests.`);
        }
        signal.throwIfAborted();
        if (!account.schedulable) {
          opened = true;
          await admin.setSchedulable(id, true);
        }
        // Group bindings reach the scheduler via its outbox worker (default poll interval: 1 s).
        await delay(1_000, undefined, { signal });
        for (let requestNumber = 1; requestNumber <= repeat && !signal.aborted; requestNumber++) {
          log(`Account ${id}: request ${requestNumber}/${repeat}`);
          const response = await sendProbe(options, signal);
          const result = { accountId: id, name: account.name, requestNumber, ...response };
          results.push(result);
          onResult?.(result);
          if (result.error !== undefined) exitCode = 1;
        }
      } finally {
        log(`Account ${id}: ${opened ? `restoring scheduling and removing from ${group.name}` : `removing from ${group.name}`}`);
        try {
          if (opened) await admin.setSchedulable(id, false);
          await admin.setGroups(id, originalGroupIds);
        } catch (error) {
          restoreFailed = true;
          const reapply = opened
            ? `schedulable=false then group_ids=[${originalGroupIds.join(",")}]`
            : `group_ids=[${originalGroupIds.join(",")}]`;
          log(`Account ${id}: restore failed (${errorMessage(error)}). Reapply ${reapply}.`);
        }
      }
    } catch (error) {
      if (!signal.aborted) log(`Account ${id}: ${errorMessage(error)}`);
      exitCode = 1;
    }
    if (restoreFailed) {
      exitCode = 1;
      break;
    }
  }
  return { exitCode: signal.aborted ? 1 : exitCode, results };
}

function printResults(results: ProbeResult[]) {
  const rows = [["Account", "Name", "Request #", "HTTP", "First-token s", "Total s", "Output / error"]];
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ");
  for (const result of results) {
    rows.push([
      String(result.accountId), oneLine(result.name), String(result.requestNumber),
      String(result.status ?? "-"), result.firstTokenSeconds?.toFixed(3) ?? "-", result.totalSeconds.toFixed(3),
      result.error === undefined ? [...oneLine(result.output)].slice(0, 120).join("") : oneLine(result.error),
    ]);
  }
  const widths = rows[0].slice(0, -1).map((_, column) =>
    rows.reduce((width, row) => Math.max(width, Bun.stringWidth(row[column])), 0));
  console.log(rows.map((row) => row.map((cell, column) =>
    column < widths.length ? cell + " ".repeat(widths[column] - Bun.stringWidth(cell)) : cell).join("  ")).join("\n"));

  for (const result of results) {
    if (result.output) console.log(`\nAccount ${result.accountId} (request ${result.requestNumber})\n${result.output}`);
  }
}

function positiveInteger(value: string, label: string) {
  const number = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(signal: AbortSignal) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string" },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      repeat: { type: "string", default: "1" },
    },
    allowPositionals: true,
  });
  if (!positionals.length) throw new Error("At least one account id is required");
  if (!values.model) throw new Error("--model is required");
  const promptFile = values["prompt-file"];
  if ((values.prompt === undefined) === (promptFile === undefined)) {
    throw new Error("Pass exactly one of --prompt and --prompt-file");
  }
  const baseUrl = requiredEnv("SUB2API_URL");
  const { admin, probe, probeGroupName } = readProbeConfig(process.env.GUARD_DB ?? defaultGuardDbPath);
  if (!admin) throw new Error("Admin API Key is not set on the status page");
  if (!probe) throw new Error("Probe API Key is not set on the status page");
  const { exitCode, results } = await runProbe({
    baseUrl,
    adminApiKey: admin,
    probeApiKey: probe,
    groupName: probeGroupName,
    accountIds: positionals.map((id) => positiveInteger(id, "Account id")),
    model: values.model,
    repeat: positiveInteger(values.repeat, "--repeat"),
    prompt: values.prompt ?? await Bun.file(promptFile!).text(),
    log: console.error,
  }, signal);
  printResults(results);
  process.exitCode = exitCode;
}

if (import.meta.main) {
  const controller = new AbortController();
  function interrupt() {
    if (controller.signal.aborted) return;
    console.error("Interrupted. Waiting for any account restore to finish.");
    controller.abort();
  }

  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await main(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) console.error(errorMessage(error));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
