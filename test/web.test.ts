import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
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
    accounts: [account(1, { closedAt: "2026-11-19T00:00:00.000Z" })],
  });

  expect(store.status().accounts).toEqual([{
    id: 1,
    name: "账号 1",
    concurrency: 2,
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
  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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
  store.recordTick({ now: tickAt, accounts: [account(1, { closedAt: "2026-11-19T00:00:00.000Z" }), account(7, { concurrency: 1 })] });
  store.addDecision(closeDecision(1));

  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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
    ]);
    expect(snapshot.accounts[0]).toEqual({
      id: 1,
      name: "账号 1",
      concurrency: 2,
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

  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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
  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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

test("shows a login error for a wrong password", async () => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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
  const server = startStatusServer(store, 0, webPassword, () => now);
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
  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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
  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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
  expect(() => startStatusServer(store, 0, config.webPassword).stop(true)).toThrow("WEB_PASSWORD is empty");
});

test.each([
  { name: "tampered signature", cookie: `${sessionCookie.slice(0, -1)}0`, password: webPassword, now: tickTime },
  { name: "tampered expiry", cookie: sessionCookie.replace("1797681600", "1797681601"), password: webPassword, now: tickTime },
  { name: "expired session", cookie: sessionCookie, password: webPassword, now: tickTime + 30 * 86_400_000 },
  { name: "previous password", cookie: sessionCookie, password: "new-web-password", now: tickTime },
])("rejects a cookie with $name", async ({ cookie, password, now }) => {
  const store = createStatusStore({ groupId: 34, dryRun: true, policy });
  const server = startStatusServer(store, 0, password, () => now);
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
  const server = startStatusServer(store, 0, webPassword, () => tickTime);
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
