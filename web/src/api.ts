import type { ProbeRun } from "../../src/web/probe-runner";
import type { DecisionRecord, RecordedAccount, SeriesResponse, Settings, StatusSnapshot } from "../../src/web/store";

export type { DecisionRecord, ProbeRun, RecordedAccount, SeriesResponse, Settings, StatusSnapshot };
export type Range = SeriesResponse["range"];
export type SeriesAccount = SeriesResponse["accounts"][number];
export type ManualChange =
  | { concurrency: number }
  | { priority: number }
  | { loadFactor: number | null }
  | { schedulable: boolean };

export class Unauthorized extends Error {}

async function call<Data>(path: string, init?: RequestInit): Promise<Data> {
  const response = await fetch(path, { cache: "no-store", ...init });
  if (response.status === 401 && !path.startsWith("/login")) throw new Unauthorized();
  if (response.status === 204) return undefined as Data;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as Data;
}

const postJson = <Data>(path: string, body?: unknown) => call<Data>(path, {
  method: "POST",
  headers: body === undefined ? undefined : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  status: () => call<StatusSnapshot>("/api/status"),
  series: (range: Range) => call<SeriesResponse>(`/api/series?range=${range}`),
  changeAccount: (id: number, change: ManualChange) => postJson<{ ok: true }>(`/api/accounts/${id}`, change),
  saveSettings: (settings: Settings) => postJson<{ ok: true }>("/api/settings", settings),
  probe: () => call<{ run: ProbeRun | null }>("/api/probe"),
  startProbe: (request: ProbeRun["request"]) => postJson<{ id: number }>("/api/probe", request),
  cancelProbe: () => postJson<void>("/api/probe/cancel"),
  login: (password: string) => call<void>("/login", { method: "POST", body: new URLSearchParams({ password }) }),
  logout: () => call<void>("/logout", { method: "POST" }),
};
