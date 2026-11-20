import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { openGuardDb, type GuardDb } from "../src/guard-db";
import { createManualChange } from "../src/main";
import { openAdminApi } from "../src/sub2api";
import { startStatusServer } from "../src/web/server";
import { createStatusStore, type DecisionRecord, type StatusSnapshot, type TickAccount } from "../src/web/store";

const policy = {
  windowMinutes: 10,
  minRequests: 20,
  errorRate: 0.05,
  cooldownMinutes: 10,
  healthyMinutes: 30,
  healthyRate: 0.01,
  minSchedulable: 4,
  reopenMinutes: 720,
  maxConcurrency: 3,
  maxOverrides: {},
};

const tickAt = "2026-11-19T12:00:00.000Z";
const tickTime = Date.parse(tickAt);
const webPassword = "test-web-password";
const manualDisabled = async () => "disabled" as const;
const sessionCookie = "guard_session=1797681600.fda6cdd2b2aa5c15800cae0baf1767930bb0e4fbb1ea595588ba74cc0172095d";

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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  for (let id = 1; id <= 205; id += 1) store.addDecision(decreaseDecision(id));

  const { decisions } = store.status();
  expect(decisions).toHaveLength(200);
  expect(decisions[0]?.id).toBe(205);
  expect(decisions[199]?.id).toBe(6);
});

test("shows a closed account from fresh tick data with its reopen time", () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordTick({
    now: tickAt,
    accounts: [account(1, { closed: true, closedAt: "2026-11-19T00:00:00.000Z" })],
  });

  expect(store.status().accounts).toEqual([{
    id: 1,
    name: "账号 1",
    concurrency: 2,
    priority: 10,
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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await login(server.url, webPassword);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toBe(
      `${sessionCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
  } finally {
    server.stop(true);
  }
});

test("serves the snapshot at /api/status", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: false, policy: { ...policy, maxOverrides: { "7": 2 } } });
  store.recordTick({
    now: tickAt,
    accounts: [
      account(1, { closed: true, closedAt: "2026-11-19T00:00:00.000Z", priority: 1, loadFactor: 4 }),
      account(7, { concurrency: 1 }),
      account(9, { closed: true }),
    ],
  });
  store.addDecision(closeDecision(1));

  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await fetch(new URL("/api/status", server.url), { headers: { cookie: sessionCookie } });
    const snapshot = await response.json() as StatusSnapshot;

    expect(response.status).toBe(200);
    expect(snapshot.dryRun).toBe(false);
    expect(snapshot.groupId).toBe(34);
    expect(snapshot.policy).toEqual({ ...policy, maxOverrides: { "7": 2 } });
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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordError("2026-11-19T11:59:00.000Z", "connect ECONNREFUSED");

  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
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

test("shows the login form and protects status from anonymous requests", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
  try {
    const page = await fetch(server.url);
    expectHtml(page, 200);
    const html = await page.text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<form method="post" action="/login">');
    expect(html).toContain('type="password"');

    const response = await fetch(new URL("/api/status", server.url));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  } finally {
    server.stop(true);
  }
});

test("protects manual account changes from anonymous requests", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  store.recordTick({ now: tickAt, accounts: [account(1)] });
  const { state, decisions, close } = openGuardDb(":memory:", true);
  const changeAccount = createManualChange({ store, admin: undefined, state, simulated: new Map(), decisions });
  const server = startStatusServer(store, 0, webPassword, changeAccount, () => tickTime);
  try {
    const status = await fetch(new URL("/api/status", server.url), { headers: { cookie: sessionCookie } });
    expect((await status.json() as StatusSnapshot).manualEnabled).toBe(false);

    for (const [id, code, error] of [
      [99, 404, "账号不在列表里"],
      [1, 409, "没有设置 ADMIN_API_KEY，不能手动调整"],
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
  const { state, decisions, close } = openGuardDb(":memory:", dryRun);
  try {
    const closedAt = simulatedConcurrency === undefined || simulatedConcurrency === null ? "2026-11-19T00:00:00.000Z" : undefined;
    state.set(1, { closedAt, lastChangeAt: tickAt });
    const store = createStatusStore({ groupId: 34, dryRun, policy, manualEnabled: true });
    store.recordTick({
      now: tickAt,
      accounts: [account(1, {
        concurrency: simulatedConcurrency ?? 2,
        closed: closedAt !== undefined,
        closedAt: closedAt ?? null,
        lastChangeAt: tickAt,
      })],
    });
    const admin = openAdminApi(adminServer.url.href, "test-key");
    const simulated = new Map(simulatedConcurrency === undefined ? [] : [[1, {
      concurrency: simulatedConcurrency, actual: { concurrency: 2, closed: false },
    }]]);
    const changeAccount = createManualChange({ store, admin, state, simulated, decisions });
    const server = startStatusServer(store, 0, webPassword, changeAccount, () => tickTime);
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
    expect((await manualStatus(url)).accounts[0]).toMatchObject({ concurrency, closed, closedAt: null, reopenAt: null });

    expect((await postManualChange(url, { schedulable: true })).status).toBe(200);
    expect((await manualStatus(url)).accounts[0]).toMatchObject({ concurrency, closed: false, closedAt: null, reopenAt: null });
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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await login(server.url, "wrong");
    expectHtml(response, 401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("密码不对");
  } finally {
    server.stop(true);
  }
});

test("limits the sixth attempt by the last forwarded IP and lets failures age out", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  let now = tickTime;
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => now);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      now = tickTime + attempt * 60_000;
      const response = await login(server.url, "wrong", `198.51.100.${attempt + 1}, 203.0.113.1`);
      expect(response.status).toBe(401);
    }
    const limited = await login(server.url, "wrong", "198.51.100.6, 203.0.113.1");
    expectHtml(limited, 429);
    expect(await limited.text()).toContain("试太多次了，15 分钟后再试");
    expect((await login(server.url, "wrong", "198.51.100.6, 203.0.113.2")).status).toBe(401);

    now = tickTime + 15 * 60_000;
    expect((await login(server.url, "wrong", "203.0.113.1")).status).toBe(401);
    expect((await login(server.url, "wrong", "203.0.113.1")).status).toBe(429);
  } finally {
    server.stop(true);
  }
});

test("shares the peer IP limit between direct and forwarded logins", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await login(server.url, webPassword);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const page = await fetch(server.url, { headers: { cookie } });
    expectHtml(page, 200);
    const html = await page.text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<form method="post" action="/logout"');
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
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  expect(() => startStatusServer(store, 0, config.webPassword, manualDisabled).stop(true)).toThrow("WEB_PASSWORD is empty");
});

test.each([
  { name: "tampered signature", cookie: `${sessionCookie.slice(0, -1)}0`, password: webPassword, now: tickTime },
  { name: "tampered expiry", cookie: sessionCookie.replace("1797681600", "1797681601"), password: webPassword, now: tickTime },
  { name: "expired session", cookie: sessionCookie, password: webPassword, now: tickTime + 30 * 86_400_000 },
  { name: "previous password", cookie: sessionCookie, password: "new-web-password", now: tickTime },
])("rejects a cookie with $name", async ({ cookie, password, now }) => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, password, manualDisabled, () => now);
  try {
    const headers = { cookie };
    const response = await fetch(new URL("/api/status", server.url), { headers });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(await (await fetch(server.url, { headers })).text()).toContain('action="/login"');
  } finally {
    server.stop(true);
  }
});

test("logs out by expiring the session cookie and returning to the home page", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, manualDisabled, () => tickTime);
  try {
    const response = await fetch(new URL("/logout", server.url), {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sessionCookie },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toBe("guard_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  } finally {
    server.stop(true);
  }
});
