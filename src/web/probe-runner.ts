import type { GuardDb } from "../guard-db";
import { runProbe, type ProbeResult } from "../probe";
import type { StatusStore } from "./store";

export type ProbeRun = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  request: { accountIds: number[]; model: string; prompt: string; repeat: number };
  logs: { ts: string; message: string }[];
  results: ProbeResult[];
  exitCode: number | null;
  error: string | null;
  cancelled: boolean;
};

type ProbeStartSettings = Pick<Parameters<typeof runProbe>[0], "adminApiKey" | "probeApiKey" | "groupName">;
type ProbeReply = { status: number; body?: { error: string } | { id: number } | { run: ProbeRun | null } };

function readRequest(body: unknown, store: Pick<StatusStore, "getAccount">): ProbeRun["request"] | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const { accountIds, model, prompt, repeat } = body as Record<string, unknown>;
  if (!Array.isArray(accountIds) || !accountIds.length || new Set(accountIds).size !== accountIds.length) return;
  if (!accountIds.every((id) => Number.isInteger(id) && store.getAccount(id))) return;
  if (typeof model !== "string" || !model.trim() || typeof prompt !== "string" || !prompt.trim()) return;
  if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1 || repeat > 10) return;
  return { accountIds, model, prompt, repeat };
}

export function createProbeRunner({ baseUrl, getApiKeys, now = Date.now }: {
  baseUrl: string;
  getApiKeys: GuardDb["apiKeys"]["get"];
  now?: () => number;
}) {
  const timestamp = () => new Date(now()).toISOString();
  let lastRun: ProbeRun | null = null;
  let active: { run: ProbeRun; controller: AbortController; done: Promise<void> } | undefined;

  async function execute(run: ProbeRun, settings: ProbeStartSettings, signal: AbortSignal) {
    try {
      const { exitCode } = await runProbe({
        baseUrl, ...settings, ...run.request,
        log: (message) => run.logs.push({ ts: timestamp(), message }),
        onResult: (result) => run.results.push(result),
      }, signal);
      run.exitCode = exitCode;
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      run.exitCode = 1;
    } finally {
      run.finishedAt = timestamp();
      active = undefined;
    }
  }

  function abort(current: NonNullable<typeof active>) {
    current.run.cancelled = true;
    current.controller.abort();
  }

  return {
    read(): ProbeReply {
      return { status: 200, body: { run: lastRun } };
    },
    start(body: unknown, store: Pick<StatusStore, "getAccount" | "getSettings">): ProbeReply {
      const { admin, probe } = getApiKeys();
      if (!admin || !probe) return { status: 409, body: { error: "请先在设置页填 Admin API Key 和 Probe API Key，才能测试" } };
      if (active) return { status: 409, body: { error: "已经有测试在跑，等它结束" } };
      const request = readRequest(body, store);
      if (!request) return { status: 400, body: { error: "参数不对" } };

      const run: ProbeRun = {
        id: (lastRun?.id ?? 0) + 1,
        startedAt: timestamp(), finishedAt: null, request, logs: [], results: [],
        exitCode: null, error: null, cancelled: false,
      };
      lastRun = run;
      const controller = new AbortController();
      const { probeGroupName } = store.getSettings().value;
      active = {
        run, controller,
        done: execute(run, { adminApiKey: admin, probeApiKey: probe, groupName: probeGroupName }, controller.signal),
      };
      return { status: 202, body: { id: run.id } };
    },
    cancel(): ProbeReply {
      if (!active) return { status: 409, body: { error: "没有正在跑的测试" } };
      abort(active);
      return { status: 204 };
    },
    async shutdown() {
      if (!active) return;
      const current = active;
      abort(current);
      await current.done;
    },
  };
}

export type ProbeRunner = ReturnType<typeof createProbeRunner>;
