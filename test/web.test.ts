import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openGuardDb, type GuardDb } from "../src/guard-db";
import { createGuard, createManualChange } from "../src/main";
import { defaultSettings } from "../src/settings";
import { openAdminApi } from "../src/sub2api";
import { createProbeRunner } from "../src/web/probe-runner";
import { startStatusServer, type ChangeAccount } from "../src/web/server";
import { createStatusStore, type DecisionRecord, type StatusSnapshot, type StatusStore, type TickAccount } from "../src/web/store";

const pageHtml = '<!doctype html><html lang="zh-CN"><div id="root"></div></html>';
let dist: string;
beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "sub2api-guard-web-"));
  const assets = join(dist, "assets");
  await mkdir(assets);
  await writeFile(join(dist, "index.html"), pageHtml);
  await writeFile(join(assets, "index-abc.js"), "export const app = 1;");
  await symlink("../index.html", join(assets, "outside.html"));
});
afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

const tickAt = "2026-11-19T12:00:00.000Z";
const tickTime = Date.parse(tickAt);
const webPassword = "test-web-password";
const manualDisabled = async () => "disabled" as const;
const probe = createProbeRunner({ baseUrl: "",
  getApiKeys: () => ({ admin: null, probe: null, updatedAt: null }),
});
const sessionCookie = "guard_session=1797681600.fda6cdd2b2aa5c15800cae0baf1767930bb0e4fbb1ea595588ba74cc0172095d";

function startTestServer(store: StatusStore, password: string, changeAccount: ChangeAccount, now = () => tickTime) {
  return startStatusServer(store, 0, password, { dist, changeAccount, now, probe,
    saveSettings: async () => { throw new Error("Unexpected settings write"); },
    saveApiKeys: async () => { throw new Error("Unexpected API key write"); },
    series: async (range) => ({ range, bucketMinutes: 5, from: tickAt, to: tickAt, accounts: [] }),
  });
}

function login(url: URL, password: string, forwardedFor?: string) {
  return fetch(new URL("/login", url), {
    method: "POST",
    body: new URLSearchParams({ password }),
    redirect: "manual",
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  });
}

function account(id: number, overrides: Partial<TickAccount> = {}): TickAccount {
  return {
    id,
    name: `账号 ${id}`,
    concurrency: 2,
    priority: 10,
    priorityBump: 0,
    loadFactor: null,
    closed: false,
    closedAt: null,
    usable: true,
    since: "2026-11-19T11:50:00.000Z",
    recent: { errors: 3, successes: 37 },
    healthy: { errors: 1, successes: 99 },
    ...overrides,
  };
}

function decreaseDecision(id: number): DecisionRecord {
  return {
    ts: tickAt,
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
    dryRun: true,
  };
}

function closeDecision(id: number): DecisionRecord {
  return {
    ts: tickAt,
    event: "close",
    id,
    name: `账号 ${id}`,
    concurrency: 1,
    remainingUsable: 4,
    minSchedulable: 4,
    minRequests: 20,
    errorRate: 0.05,
    cooldownMinutes: 10,
    errors: 8,
    successes: 12,
    total: 20,
    rate: 0.4,
    since: "2026-11-19T11:50:00.000Z",
    lastChangeAt: null,
    dryRun: true,
  };
}

test("keeps the 200 newest decisions, newest first", () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  for (let id = 1; id <= 205; id += 1) store.addDecision(decreaseDecision(id));

  const { decisions } = store.status();
  expect(decisions).toHaveLength(200);
  expect(decisions[0]?.id).toBe(205);
  expect(decisions[199]?.id).toBe(6);
});

test("shows a closed account from fresh tick data with its reopen time", () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  store.recordTick({
    now: tickAt,
    accounts: [account(1, { closed: true, closedAt: "2026-11-19T00:00:00.000Z" })],
  });

  expect(store.status().accounts).toEqual([{
    id: 1,
    name: "账号 1",
    concurrency: 2,
    priority: 10,
    priorityBump: 0,
    loadFactor: null,
    maxConcurrency: 3,
    usable: true,
    closed: true,
    closedAt: "2026-11-19T00:00:00.000Z",
    reopenAt: "2026-11-19T12:00:00.000Z",
    lastChangeAt: null,
    recent: { since: "2026-11-19T11:50:00.000Z", errors: 3, successes: 37, total: 40, rate: 0.075 },
    healthy: { errors: 1, successes: 99, total: 100, rate: 0.01 },
  }]);
});

test("logs in with the shared password and sets the signed session cookie for 30 days", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await login(server.url, webPassword);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("set-cookie")).toBe(
      `${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
  } finally {
    server.stop(true);
  }
});

test("serves the snapshot at /api/status", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: false, settings: { value: { ...defaultSettings, maxOverrides: { "7": 2 } }, updatedAt: null } });
  store.recordTick({
    now: tickAt,
    accounts: [
      account(1, { closed: true, closedAt: "2026-11-19T00:00:00.000Z", priority: 1, loadFactor: 4 }),
      account(7, { concurrency: 1 }),
      account(9, { closed: true }),
    ],
  });
  store.addDecision(closeDecision(1));

  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await fetch(new URL("/api/status", server.url), { headers: { cookie: sessionCookie } });
    const snapshot = await response.json() as StatusSnapshot;

    expect(response.status).toBe(200);
    expect(snapshot.dryRun).toBe(false);
    expect(snapshot.groupId).toBe(34);
    expect(snapshot.settings).toEqual({ ...defaultSettings, maxOverrides: { "7": 2 } });
    expect(snapshot.settingsUpdatedAt).toBeNull();
    expect(snapshot.lastTickAt).toBe(tickAt);
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.accounts.map(({ id, maxConcurrency, closed }) => ({ id, maxConcurrency, closed }))).toEqual([
      { id: 1, maxConcurrency: 3, closed: true },
      { id: 7, maxConcurrency: 2, closed: false },
      { id: 9, maxConcurrency: 3, closed: true },
    ]);
    expect(snapshot.accounts[2]).toMatchObject({ closed: true, closedAt: null, reopenAt: null });
    expect(snapshot.accounts[0]).toEqual({
      id: 1,
      name: "账号 1",
      concurrency: 2,
      priority: 1,
      priorityBump: 0,
      loadFactor: 4,
      maxConcurrency: 3,
      usable: true,
      closed: true,
      closedAt: "2026-11-19T00:00:00.000Z",
      reopenAt: "2026-11-19T12:00:00.000Z",
      lastChangeAt: null,
      recent: { since: "2026-11-19T11:50:00.000Z", errors: 3, successes: 37, total: 40, rate: 0.075 },
      healthy: { errors: 1, successes: 99, total: 100, rate: 0.01 },
    });
    expect(snapshot.decisions).toEqual([closeDecision(1)]);
    expect(typeof snapshot.now).toBe("string");
  } finally {
    server.stop(true);
  }
});

test("reports the latest tick error and clears it on the next tick", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  store.recordError("2026-11-19T11:59:00.000Z", "connect ECONNREFUSED");

  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const url = new URL("/api/status", server.url);
    const headers = { cookie: sessionCookie };
    const before = await (await fetch(url, { headers })).json() as StatusSnapshot;
    expect(before.lastTickAt).toBeNull();
    expect(before.lastError).toEqual({ ts: "2026-11-19T11:59:00.000Z", message: "connect ECONNREFUSED" });

    store.recordTick({ now: tickAt, accounts: [account(1)] });
    const after = await (await fetch(url, { headers })).json() as StatusSnapshot;
    expect(after.lastError).toBeNull();
    expect(after.lastTickAt).toBe(tickAt);
  } finally {
    server.stop(true);
  }
});

const contentSecurityPolicy = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

function expectHtml(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

test("serves the SPA and protects status from anonymous requests", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const page = await fetch(server.url);
    expectHtml(page, 200);
    expect(await page.text()).toBe(pageHtml);

    const response = await fetch(new URL("/api/status", server.url));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  } finally {
    server.stop(true);
  }
});

test("protects manual account changes from anonymous requests", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await fetch(new URL("/api/accounts/1", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concurrency: 2 }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  } finally {
    server.stop(true);
  }
});

test.each([
  ["application/json", '{"priority":1,"concurrency":2}'],
  ["application/json", '{"concurrency":"2"}'],
  ["application/json", '{"loadFactor":0}'],
  ["application/json", '{"loadFactor":10001}'],
  ["application/json", '{"priority":-1}'],
  ["application/json", '{"concurrency":1.5}'],
  ["application/json", '{"schedulable":1}'],
  ["application/json", '{"unknown":1}'],
  ["application/json", '{}'],
  ["application/json", 'null'],
  ["application/json", '{'],
  ["text/plain", '{"concurrency":2}'],
])("rejects invalid manual input (%s, %s)", async (contentType, body) => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await fetch(new URL("/api/accounts/1", server.url), {
      method: "POST",
      headers: { cookie: sessionCookie, "content-type": contentType },
      body,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "参数不对" });
  } finally {
    server.stop(true);
  }
});

test("rejects unknown accounts and manual changes without an admin key", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  const { state, decisions, close } = openGuardDb(":memory:", true);
  const changeAccount = createManualChange({ store, getAdmin: () => undefined, state, simulated: new Map(), decisions });
  const server = startTestServer(store, webPassword, changeAccount, () => tickTime);
  try {
    const status = await fetch(new URL("/api/status", server.url), { headers: { cookie: sessionCookie } });
    expect((await status.json() as StatusSnapshot).manualEnabled).toBe(false);

    for (const [id, code, error] of [
      [99, 404, "账号不在列表里"],
      [1, 409, "请先在设置页填 Admin API Key，才能手动调整"],
    ] as const) {
      const response = await fetch(new URL(`/api/accounts/${id}`, server.url), {
        method: "POST",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 2 }),
      });
      expect(response.status).toBe(code);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error });
    }
    expect(state.get(1)).toBeUndefined();
    expect(state.get(99)).toBeUndefined();
    expect(decisions.recent(1)).toEqual([]);
  } finally {
    server.stop(true);
    close();
  }
});

async function withManualServer(
  dryRun: boolean,
  upstream: (request: Request) => Response | Promise<Response>,
  check: (context: { url: URL; state: GuardDb["state"]; decisions: GuardDb["decisions"] }) => Promise<void>,
  simulatedConcurrency?: number | null,
) {
  const adminServer = Bun.serve({ port: 0, fetch: upstream });
  const { state, decisions, apiKeys, close } = openGuardDb(":memory:", dryRun);
  try {
    apiKeys.save({ admin: "test-key" }, tickAt);
    const closedAt = simulatedConcurrency === undefined || simulatedConcurrency === null ? "2026-11-19T00:00:00.000Z" : undefined;
    state.set(1, { closedAt, lastChangeAt: tickAt, priorityBump: 3 });
    const store = createStatusStore({ groupId: 34, dryRun, getApiKeys: apiKeys.get });
    store.recordTick({
      now: tickAt,
      accounts: [account(1, {
        concurrency: simulatedConcurrency ?? 2,
        priorityBump: 3,
        closed: closedAt !== undefined,
        closedAt: closedAt ?? null,
        lastChangeAt: tickAt,
      })],
    });
    const admin = openAdminApi(adminServer.url.href, "test-key");
    const simulated = new Map(simulatedConcurrency === undefined ? [] : [[1, {
      concurrency: simulatedConcurrency, actual: { concurrency: 2, closed: false },
    }]]);
    const changeAccount = createManualChange({ store, getAdmin: () => admin, state, simulated, decisions, now: () => tickTime });
    const server = startTestServer(store, webPassword, changeAccount, () => tickTime);
    try {
      await check({ url: server.url, decisions, state });
    } finally {
      server.stop(true);
    }
  } finally {
    adminServer.stop(true);
    close();
  }
}

function postManualChange(url: URL, change: object) {
  return fetch(new URL("/api/accounts/1", url), {
    method: "POST",
    headers: { cookie: sessionCookie, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(change),
  });
}

async function manualStatus(url: URL) {
  const response = await fetch(new URL("/api/status", url), { headers: { cookie: sessionCookie } });
  expect(response.status).toBe(200);
  return await response.json() as StatusSnapshot;
}

test.each([true, false])("applies and records manual changes immediately with dryRun=%s", async (dryRun) => {
  const writes: unknown[] = [];
  await withManualServer(dryRun, async (request) => {
    writes.push({ path: new URL(request.url).pathname, body: await request.json() });
    return Response.json({ code: 0, data: { success_ids: [1] } });
  }, async ({ url, decisions, state }) => {
    const before = await manualStatus(url);
    expect(before.manualEnabled).toBe(true);
    for (const [field, from, to] of [
      ["concurrency", 2, 4],
      ["priority", 10, 0],
      ["loadFactor", null, 10000],
      ["loadFactor", 10000, null],
      ["schedulable", false, false],
      ["schedulable", false, true],
    ] as const) {
      const previousChangeAt = state.get(1)?.lastChangeAt ?? null;
      const response = await postManualChange(url, { [field]: to });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ok: true });

      const snapshot = await manualStatus(url);
      const [row] = snapshot.accounts;
      expect(snapshot.lastTickAt).toBe(tickAt);
      if (field === "schedulable") {
        expect(row).toMatchObject({ closed: !to, closedAt: null, reopenAt: null });
        expect(state.get(1)?.closedAt).toBeUndefined();
      } else {
        expect(row[field]).toBe(to);
        expect(row.closedAt).toBe("2026-11-19T00:00:00.000Z");
      }
      expect(row.priorityBump).toBe(field === "concurrency" ? 3 : 0);
      expect(state.get(1)?.priorityBump).toBe(row.priorityBump);
      const [decision] = snapshot.decisions;
      const lastChangeAt = field === "concurrency" || (field === "schedulable" && to) ? decision.ts : previousChangeAt;
      expect(row.lastChangeAt).toBe(lastChangeAt);
      expect(state.get(1)?.lastChangeAt ?? null).toBe(lastChangeAt);
      expect(decision).toEqual({
        ts: expect.any(String), event: "manual", id: 1, name: "账号 1",
        concurrency: 4, lastChangeAt, dryRun, field, from, to,
      });
      expect(decisions.recent(200)).toEqual(snapshot.decisions);
    }
  });
  expect(writes).toEqual([
    { path: "/api/v1/admin/accounts/bulk-update", body: { account_ids: [1], concurrency: 4 } },
    { path: "/api/v1/admin/accounts/bulk-update", body: { account_ids: [1], priority: 0 } },
    { path: "/api/v1/admin/accounts/bulk-update", body: { account_ids: [1], load_factor: 10000 } },
    { path: "/api/v1/admin/accounts/bulk-update", body: { account_ids: [1], load_factor: 0 } },
    { path: "/api/v1/admin/accounts/1/schedulable", body: { schedulable: false } },
    { path: "/api/v1/admin/accounts/1/schedulable", body: { schedulable: true } },
  ]);
});

test.each([
  { simulatedConcurrency: null, change: { concurrency: 4 }, concurrency: 4, closed: false },
  { simulatedConcurrency: 5, change: { schedulable: false }, concurrency: 2, closed: true },
])("manual changes replace the dry-run override $simulatedConcurrency", async ({ simulatedConcurrency, change, concurrency, closed }) => {
  await withManualServer(true, () => Response.json({ code: 0, data: { success_ids: [1] } }), async ({ url }) => {
    expect((await postManualChange(url, change)).status).toBe(200);
    expect((await manualStatus(url)).accounts[0]).toMatchObject({ concurrency, closed, closedAt: null, reopenAt: null, priorityBump: 3 });

    expect((await postManualChange(url, { schedulable: true })).status).toBe(200);
    expect((await manualStatus(url)).accounts[0]).toMatchObject({ concurrency, closed: false, closedAt: null, reopenAt: null, priorityBump: 3 });
  }, simulatedConcurrency);
});

test("reports a rejected admin write and leaves status and history intact", async () => {
  await withManualServer(true, () => Response.json({ code: 73 }), async ({ url, decisions, state }) => {
    const before = await manualStatus(url);
    const previousState = state.get(1);
    const response = await postManualChange(url, { schedulable: true });
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "sub2api 拒绝了修改：Admin API rejected request (code 73)" });
    const after = await manualStatus(url);
    expect(after.accounts).toEqual(before.accounts);
    expect(after.decisions).toEqual([]);
    expect(decisions.recent(200)).toEqual([]);
    expect(state.get(1)).toEqual(previousState);
  });
});

test("shows a login error for a wrong password", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await login(server.url, "wrong");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "密码不对" });
  } finally {
    server.stop(true);
  }
});

test("limits the sixth attempt by the last forwarded IP and lets failures age out", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  let now = tickTime;
  const server = startTestServer(store, webPassword, manualDisabled, () => now);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      now = tickTime + attempt * 60_000;
      const response = await login(server.url, "wrong", `198.51.100.${attempt + 1}, 203.0.113.1`);
      expect(response.status).toBe(401);
    }
    const limited = await login(server.url, "wrong", "198.51.100.6, 203.0.113.1");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "试太多次了，15 分钟后再试" });
    expect((await login(server.url, "wrong", "198.51.100.6, 203.0.113.2")).status).toBe(401);

    now = tickTime + 15 * 60_000;
    expect((await login(server.url, "wrong", "203.0.113.1")).status).toBe(401);
    expect((await login(server.url, "wrong", "203.0.113.1")).status).toBe(429);
  } finally {
    server.stop(true);
  }
});

test("shares the peer IP limit between direct and forwarded logins", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const url = new URL(server.url);
    url.hostname = "127.0.0.1";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(url, "wrong")).status).toBe(401);
    }
    expect((await login(url, webPassword)).status).toBe(429);
    // Bun can report an IPv4 peer as an IPv4-mapped IPv6 address.
    const peerStatuses = await Promise.all(["127.0.0.1", "::ffff:127.0.0.1"].map(async (address) => {
      return (await login(url, webPassword, address)).status;
    }));
    expect(peerStatuses).toContain(429);
  } finally {
    server.stop(true);
  }
});

test("shows the status page after login and rejects unknown paths and methods", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await login(server.url, webPassword);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const page = await fetch(server.url, { headers: { cookie } });
    expectHtml(page, 200);
    expect(await page.text()).toBe(pageHtml);
    expect((await fetch(new URL("/api/status", server.url), { headers: { cookie } })).status).toBe(200);

    const missing = await fetch(new URL("/nope", server.url));
    expect(missing.status).toBe(404);
    for (const path of ["/login", "/logout"]) {
      expect((await fetch(new URL(path, server.url))).status).toBe(404);
    }
    for (const path of ["/", "/api/status"]) {
      expect((await fetch(new URL(path, server.url), { method: "POST" })).status).toBe(404);
    }
  } finally {
    server.stop(true);
  }
});

test("an empty WEB_PASSWORD stops the status server from starting", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://unused", WEB_PASSWORD: "" });
  const store = createStatusStore({ groupId: 34, dryRun: true });
  expect(() => startTestServer(store, config.webPassword, manualDisabled).stop(true)).toThrow("WEB_PASSWORD is empty");
});

test.each([
  { name: "tampered signature", cookie: `${sessionCookie.slice(0, -1)}0`, password: webPassword, now: tickTime },
  { name: "tampered expiry", cookie: sessionCookie.replace("1797681600", "1797681601"), password: webPassword, now: tickTime },
  { name: "expired session", cookie: sessionCookie, password: webPassword, now: tickTime + 30 * 86_400_000 },
  { name: "previous password", cookie: sessionCookie, password: "new-web-password", now: tickTime },
])("rejects a cookie with $name", async ({ cookie, password, now }) => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, password, manualDisabled, () => now);
  try {
    const headers = { cookie };
    const response = await fetch(new URL("/api/status", server.url), { headers });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(await (await fetch(server.url, { headers })).text()).toBe(pageHtml);
  } finally {
    server.stop(true);
  }
});

test("logs out by expiring the session cookie", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await fetch(new URL("/logout", server.url), {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sessionCookie },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("set-cookie")).toBe("guard_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  } finally {
    server.stop(true);
  }
});

test("serves a public asset with its content type and immutable cache headers", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled);
  try {
    const asset = await fetch(new URL("/assets/index-abc.js", server.url));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("export const app = 1;");
    for (const path of ["/assets/missing.js", "/assets/..%2findex.html", "/assets/outside.html"]) {
      expect((await fetch(new URL(path, server.url))).status).toBe(404);
    }
    // Sending the path directly tests traversal before the client's URL parser can normalize it.
    for (const path of ["/assets/../", "/assets/%2e%2e/"]) {
      const status = await new Promise((resolve, reject) => {
        request({ hostname: "127.0.0.1", port: server.port, path }, (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on("error", reject).end();
      });
      expect(status).toBe(404);
    }
  } finally {
    server.stop(true);
  }
});

test("requires a session and a supported range for series", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true });
  const server = startTestServer(store, webPassword, manualDisabled);
  try {
    expect((await fetch(new URL("/api/series?range=1h", server.url))).status).toBe(401);
    const headers = { cookie: sessionCookie };
    for (const query of ["", "?range=2h", "?range=constructor"]) {
      const response = await fetch(new URL("/api/series" + query, server.url), { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "参数不对" });
    }
    const response = await fetch(new URL("/api/series?range=1h", server.url), { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ range: "1h", bucketMinutes: 5, from: tickAt, to: tickAt, accounts: [] });
  } finally {
    server.stop(true);
  }
});

function postKeys(url: URL, body: string, contentType = "application/json", cookie = sessionCookie) {
  return fetch(new URL("/api/keys", url), { method: "POST", headers: { "content-type": contentType, cookie }, body });
}

test("saves, clears, and preserves omitted API keys without exposing their values", async () => {
  const guardDb = openGuardDb(":memory:", true);
  let time = tickTime;
  const guard = createGuard({ groupId: 34, dryRun: true, sub2apiUrl: "", guardDb, now: () => time, database: {
    accounts: async () => [], closedAccounts: async () => [],
    traffic: async () => ({ errors: new Map(), successes: new Map() }),
  } });
  const server = startStatusServer(guard.store, 0, webPassword, {
    ...guard, dist, probe, now: () => time,
    series: async () => { throw new Error("Unexpected series read"); },
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const post = (body: string, contentType?: string, cookie?: string) => postKeys(server.url, body, contentType, cookie);
    const unsigned = await post('{"admin":"admin-saved"}', "application/json", "");
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toEqual({ error: "unauthorized" });
    for (const body of ['{}', '[]', 'null', '{', '{"admin":"   "}', '{"probe":42}', '{"admin":"abc","other":null}']) {
      const invalid = await post(body);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "参数不对" });
    }
    expect((await post('{"admin":"abc"}', "text/plain")).status).toBe(400);
    expect(await manualStatus(server.url)).toMatchObject({
      apiKeys: { admin: false, probe: false, updatedAt: null }, manualEnabled: false, probeEnabled: false,
    });

    const save = async (body: string, contentType?: string) => {
      const response = await post(body, contentType);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    };
    await save('{"admin":"  admin-saved  ","probe":"probe-saved"}', "application/json; charset=utf-8");
    expect(guardDb.apiKeys.get()).toEqual({ admin: "admin-saved", probe: "probe-saved", updatedAt: tickAt });
    const status = await fetch(new URL("/api/status", server.url), { headers: { cookie: sessionCookie } });
    const statusBody = await status.text();
    expect(statusBody).not.toContain("admin-saved");
    expect(statusBody).not.toContain("probe-saved");
    expect(JSON.parse(statusBody)).toMatchObject({
      apiKeys: { admin: true, probe: true, updatedAt: tickAt }, manualEnabled: true, probeEnabled: true,
    });

    time += 1_000;
    await save('{"admin":null}');
    const updatedAt = "2026-11-19T12:00:01.000Z";
    expect(guardDb.apiKeys.get()).toEqual({ admin: null, probe: "probe-saved", updatedAt });
    expect(await manualStatus(server.url)).toMatchObject({
      apiKeys: { admin: false, probe: true, updatedAt }, manualEnabled: false, probeEnabled: false,
    });
    await save('{"probe":null}');
    expect(guardDb.apiKeys.get()).toEqual({ admin: null, probe: null, updatedAt });
    expect(log.mock.calls).toEqual([
      [JSON.stringify({ event: "api_keys", admin: "set", probe: "set" })],
      [JSON.stringify({ event: "api_keys", admin: "cleared", probe: "unchanged" })],
      [JSON.stringify({ event: "api_keys", admin: "unchanged", probe: "cleared" })],
    ]);
  } finally {
    log.mockRestore();
    server.stop(true);
    guardDb.close();
  }
});

test("manual changes use the key most recently saved after startup", async () => {
  const keysUsed: (string | null)[] = [];
  const upstream = Bun.serve({ port: 0, fetch(request) {
    keysUsed.push(request.headers.get("x-api-key"));
    return Response.json({ code: 0, data: { success_ids: [1] } });
  } });
  const guardDb = openGuardDb(":memory:", true);
  const guard = createGuard({ groupId: 34, dryRun: true, sub2apiUrl: upstream.url.href, guardDb, now: () => tickTime, database: {
    accounts: async () => [account(1, { concurrency: 3 })], closedAccounts: async () => [],
    traffic: async () => ({ errors: new Map(), successes: new Map() }),
  } });
  const server = startStatusServer(guard.store, 0, webPassword, {
    ...guard, dist, probe, now: () => tickTime,
    series: async () => { throw new Error("Unexpected series read"); },
  });
  try {
    await guard.tick();
    expect((await postManualChange(server.url, { priority: 5 })).status).toBe(409);
    for (const [key, priority] of [["first-admin-key", 5], ["rotated-admin-key", 6]] as const) {
      expect((await postKeys(server.url, JSON.stringify({ admin: key }))).status).toBe(200);
      expect((await postManualChange(server.url, { priority })).status).toBe(200);
    }
    expect((await postKeys(server.url, '{"admin":null}')).status).toBe(200);
    expect((await postManualChange(server.url, { priority: 7 })).status).toBe(409);
    expect(keysUsed).toEqual(["first-admin-key", "rotated-admin-key"]);
  } finally {
    server.stop(true);
    upstream.stop(true);
    guardDb.close();
  }
});

test("requires an authenticated full JSON settings object and saves valid changes", async () => {
  const guardDb = openGuardDb(":memory:", true);
  const guard = createGuard({ groupId: 34, dryRun: true, sub2apiUrl: "", guardDb, now: () => tickTime, database: {
    accounts: async () => [], closedAccounts: async () => [],
    traffic: async () => ({ errors: new Map(), successes: new Map() }),
  } });
  const server = startStatusServer(guard.store, 0, webPassword, {
    ...guard, dist, probe, now: () => tickTime,
    series: async () => { throw new Error("Unexpected series read"); },
  });
  const url = new URL("/api/settings", server.url);
  const request = (body: string, contentType = "application/json; charset=utf-8", cookie = sessionCookie) =>
    fetch(url, { method: "POST", headers: { "content-type": contentType, cookie }, body });
  try {
    const value = { ...defaultSettings, maxOverrides: { "12": 6 }, errorPatterns: ["NEW"], minSchedulable: 0,
      priorityStep: 0, errorRate: 1, healthyRate: 1, tickSeconds: 10, barkUrl: "https://example.test/device",
      probeGroupName: "自定义测试" };
    expect((await request(JSON.stringify(value), "application/json", "")).status).toBe(401);

    const invalidValues = [
      null, [], { ...value, extra: 1 }, { ...value, priorityStep: undefined },
      { ...value, windowMinutes: 0 }, { ...value, cooldownMinutes: 1.5 },
      { ...value, healthyMinutes: "30" }, { ...value, reopenMinutes: 0 },
      { ...value, minRequests: 0 }, { ...value, maxConcurrency: 0 },
      { ...value, minSchedulable: -1 }, { ...value, priorityStep: -1 },
      { ...value, errorRate: 0 }, { ...value, healthyRate: 1.1 },
      { ...value, maxOverrides: [] }, { ...value, maxOverrides: { "-12": 6 } },
      { ...value, maxOverrides: { "12": 0 } }, { ...value, errorPatterns: [] },
      { ...value, errorPatterns: [" "] }, { ...value, errorPatterns: [42] },
      { ...value, tickSeconds: undefined }, { ...value, tickSeconds: 9 }, { ...value, tickSeconds: 3_601 },
      { ...value, tickSeconds: 10.5 }, { ...value, tickSeconds: "10" },
      { ...value, barkUrl: undefined }, { ...value, barkUrl: " " }, { ...value, barkUrl: "/push" },
      { ...value, barkUrl: "ftp://example.test/device" }, { ...value, barkUrl: 123 },
      { ...value, probeGroupName: undefined }, { ...value, probeGroupName: " \n" }, { ...value, probeGroupName: 123 },
    ];
    for (const body of [...invalidValues.map((value) => JSON.stringify(value)), "{"]) {
      const response = await request(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "参数不对" });
    }
    expect((await request(JSON.stringify(value), "text/plain")).status).toBe(400);
    expect(guardDb.settings.get().updatedAt).toBeNull();

    const response = await request(JSON.stringify(value));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(guardDb.settings.get()).toEqual({ value, updatedAt: tickAt });
    expect(await manualStatus(server.url)).toMatchObject({ settings: value, settingsUpdatedAt: tickAt });

    for (const barkUrl of ["http://example.test/device", ""]) {
      const next = { ...value, tickSeconds: 3_600, barkUrl };
      expect((await request(JSON.stringify(next))).status).toBe(200);
      expect((await manualStatus(server.url)).settings).toEqual(next);
    }
  } finally {
    server.stop(true);
    guardDb.close();
  }
});
