import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openGuardDb } from "../src/guard-db";
import { createGuard } from "../src/main";
import { runProbe } from "../src/probe";
import { defaultSettings } from "../src/settings";
import { createProbeRunner, type ProbeRun } from "../src/web/probe-runner";
import { startStatusServer } from "../src/web/server";
import type { StatusSnapshot } from "../src/web/store";

const options = {
  baseUrl: "https://sub2api.test",
  adminApiKey: "admin-test",
  probeApiKey: "sk-probe-test",
  groupName: "账号测试",
  accountIds: [135],
  model: "gpt-6.1-sol",
  prompt: "My custom prompt",
  repeat: 1,
  log: () => {},
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockSub2api(respond: (signal?: AbortSignal | null) => Response | Promise<Response>, {
  schedulable = true, failRestore = false, groupAccountCount = 1, createGroup = false,
  groupName = options.groupName, beforeRestore = async () => {},
} = {}) {
  const actions: unknown[] = [];
  const success = (data: unknown) => Response.json({ code: 0, data });
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/v1/responses") {
      expect(headers.get("authorization")).toBe("Bearer sk-probe-test");
      expect(init?.method).toBe("POST");
      expect(body).toEqual({ model: "gpt-6.1-sol", input: "My custom prompt", stream: true });
      actions.push("request");
      return respond(init?.signal);
    }
    expect(init?.signal?.aborted).toBe(false);
    expect(headers.get("x-api-key")).toBe("admin-test");
    switch (`${init?.method} ${path}`) {
      case "GET /api/v1/admin/groups/all?include_inactive=true":
        return success(createGroup ? [] : [{ id: 88, name: groupName, platform: "openai" }]);
      case "POST /api/v1/admin/groups":
        actions.push(body);
        return success({ id: 88, name: body.name, platform: body.platform });
      case "GET /api/v1/admin/users?include_subscriptions=false&page=1&page_size=100":
        return success({ items: [{ id: 5 }], pages: 1 });
      case "GET /api/v1/admin/users/5/api-keys?page=1&page_size=100":
        return success(createGroup
          ? { items: [{ id: 9, key: "sk-unrelated", group_id: 88 }], pages: 2 }
          : { items: [{ id: 6, key: "sk-probe-test", group_id: 88 }], pages: 1 });
      case "GET /api/v1/admin/users/5/api-keys?page=2&page_size=100":
        return success({ items: [{ id: 6, key: "sk-probe-test", group_id: null }], pages: 2 });
      case "PUT /api/v1/admin/api-keys/6":
        actions.push(body);
        return success({ api_key: { id: 6, group_id: 88 } });
      case "GET /api/v1/admin/accounts/135":
        return success({ id: 135, name: "test account", group_ids: [34, 12], schedulable });
      case "POST /api/v1/admin/accounts/bulk-update":
        actions.push(body);
        if (body.group_ids.includes(34)) await beforeRestore();
        return success({ success_ids: [135] });
      case "GET /api/v1/admin/accounts?group=88&page_size=1&lite=true":
        actions.push("confirm group");
        return success({ items: [{ id: 135 }], total: groupAccountCount });
      case "POST /api/v1/admin/accounts/135/schedulable":
        actions.push(body);
        if (failRestore && body.schedulable === schedulable) return new Response(null, { status: 500 });
        return success({ id: 135 });
      default:
        throw new Error(`Unexpected ${init?.method} ${path}`);
    }
  }) as unknown as typeof fetch;
  return actions;
}

const move = { account_ids: [135], group_ids: [88] };
const restore = { account_ids: [135], group_ids: [34, 12] };
const completed = () => new Response('data: {"type":"response.completed"}\n\n');

test("restores scheduling before group bindings after a successful probe", async () => {
  const actions = mockSub2api(completed);
  const { exitCode, results } = await runProbe({ ...options, repeat: 2 }, new AbortController().signal);
  expect(exitCode).toBe(0);
  expect(results.map((result) => result.requestNumber)).toEqual([1, 2]);
  expect(actions).toEqual([move, "confirm group", "request", "request", { schedulable: true }, restore]);
});

test("emits each request result before account restore", async () => {
  const actions = mockSub2api(completed);
  const messages: string[] = [];
  const updates: unknown[] = [];
  const { results } = await runProbe({ ...options, repeat: 2,
    log: (message) => messages.push(message),
    onResult(result) {
      expect(actions.at(-1)).toBe("request");
      updates.push(result);
    },
  }, new AbortController().signal);
  expect(updates).toEqual(results);
  expect(updates).toHaveLength(2);
  expect(messages).toEqual([
    "Account 135 (test account): moving to 账号测试",
    "Account 135: request 1/2",
    "Account 135: request 2/2",
    "Account 135: restoring scheduling and group bindings",
  ]);
});

test("restores scheduling before groups after an HTTP error", async () => {
  const actions = mockSub2api(() => new Response("overloaded", { status: 503 }));
  const result = await runProbe(options, new AbortController().signal);
  expect(result).toMatchObject({ exitCode: 1, results: [{ status: 503, error: "overloaded" }] });
  expect(actions).toEqual([move, "confirm group", "request", { schedulable: true }, restore]);
});

test("restores scheduling before groups after fetch throws", async () => {
  const actions = mockSub2api(() => { throw new Error("connection lost"); });
  const result = await runProbe(options, new AbortController().signal);
  expect(result).toMatchObject({ exitCode: 1, results: [{ error: "connection lost" }] });
  expect(actions).toEqual([move, "confirm group", "request", { schedulable: true }, restore]);
});

test("leaves the account isolated and stops the run if restoring closed scheduling fails", async () => {
  const actions = mockSub2api(completed, { schedulable: false, failRestore: true });
  const result = await runProbe({ ...options, accountIds: [135, 146] }, new AbortController().signal);
  expect(result.exitCode).toBe(1);
  expect(actions).toEqual([move, "confirm group", { schedulable: true }, "request", { schedulable: false }]);
  expect(globalThis.fetch).not.toHaveBeenCalledWith("https://sub2api.test/api/v1/admin/accounts/146", expect.anything());
});

test("opens a closed account only in the probe group and restores it closed", async () => {
  const actions = mockSub2api(completed, { schedulable: false });
  const result = await runProbe(options, new AbortController().signal);
  expect(result.exitCode).toBe(0);
  expect(actions).toEqual([move, "confirm group", { schedulable: true }, "request", { schedulable: false }, restore]);
});

test("creates an exclusive group and binds the exact key even when it is on a later page", async () => {
  const actions = mockSub2api(completed, { createGroup: true });
  const result = await runProbe(options, new AbortController().signal);
  expect(result.exitCode).toBe(0);
  expect(actions).toEqual([
    { name: "账号测试", platform: "openai", is_exclusive: true, rate_multiplier: 1 },
    { group_id: 88 }, move, "confirm group", "request", { schedulable: true }, restore,
  ]);
});

test("skips requests and restores when another account is in the probe group", async () => {
  const actions = mockSub2api(completed, { schedulable: false, groupAccountCount: 2 });
  const result = await runProbe(options, new AbortController().signal);
  expect(result).toMatchObject({ exitCode: 1, results: [] });
  expect(actions).toEqual([move, "confirm group", { schedulable: false }, restore]);
});

test("interrupting a request skips remaining repeats and restores with an active admin signal", async () => {
  const controller = new AbortController();
  const actions = mockSub2api((requestSignal) => {
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    requestSignal?.throwIfAborted();
    return completed();
  });
  const result = await runProbe({ ...options, repeat: 3 }, controller.signal);
  expect(result).toMatchObject({ exitCode: 1, results: [{ error: controller.signal.reason.message }] });
  expect(actions).toEqual([move, "confirm group", "request", { schedulable: true }, restore]);
});

test("collects SSE output deltas across chunks", async () => {
  const encoder = new TextEncoder();
  mockSub2api(() => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of [
        ': keepalive\r\n\r\nevent: response.output_text.delta\r\ndata: {"del',
        'ta":"Hello "}\r\n\r',
        '\ndata: {"type":"response.output_text.delta","delta":"世界\\n"}\n\ndata: [DONE]\n\n',
      ]) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  })));
  const result = await runProbe(options, new AbortController().signal);
  expect(result).toMatchObject({ exitCode: 0, results: [{ status: 200, output: "Hello 世界\n" }] });
});

test.each([
  ['data: {"type":"error","message":"upstream error"}\n\n', "upstream error"],
  ['event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"upstream failed"}}}\n\n', "upstream failed"],
])("reports SSE failure %p and restores the account", async (frame, error) => {
  const actions = mockSub2api(() => new Response(frame));
  const result = await runProbe(options, new AbortController().signal);
  expect(result).toMatchObject({ exitCode: 1, results: [{ status: 200, error }] });
  expect(actions).toEqual([move, "confirm group", "request", { schedulable: true }, restore]);
});

const tickAt = "2026-11-19T12:00:00.000Z";
const now = () => Date.parse(tickAt);
const probeRequest = { accountIds: [135], model: options.model, prompt: options.prompt, repeat: 2 };

async function withProbeServer(
  credentials: Pick<typeof options, "adminApiKey" | "probeApiKey">,
  check: (api: {
    get: (path?: string) => Promise<Response>;
    post: (path: string, value?: unknown) => Promise<Response>;
    anonymous: (path: string, method: string) => Promise<Response>;
    raw: (body: string, contentType: string) => Promise<Response>;
    shutdown: () => Promise<void>;
  }) => Promise<void>,
) {
  const guardDb = openGuardDb(":memory:", true);
  if (credentials.adminApiKey || credentials.probeApiKey) {
    guardDb.apiKeys.save({ admin: credentials.adminApiKey || null, probe: credentials.probeApiKey || null }, tickAt);
  }
  const probe = createProbeRunner({ baseUrl: options.baseUrl, getApiKeys: guardDb.apiKeys.get, now });
  const guard = createGuard({ groupId: 34, dryRun: true, sub2apiUrl: options.baseUrl, guardDb, now, database: {
    accounts: async () => [], closedAccounts: async () => [],
    traffic: async () => ({ errors: new Map(), successes: new Map() }),
  } });
  guard.store.recordTick({ now: tickAt, accounts: [{
    id: 135, name: "test account", concurrency: 3, priority: 10, priorityBump: 2, usable: true,
    recent: { errors: 0, successes: 0 }, healthy: { errors: 0, successes: 0 },
    loadFactor: null, since: tickAt, closed: false, closedAt: null,
  }] });
  const server = startStatusServer(guard.store, 0, "probe-test", {
    ...guard, dist: import.meta.dir, probe, now,
    series: async () => { throw new Error("Unexpected series read"); },
  });
  try {
    const login = await realFetch(new URL("/login", server.url), {
      method: "POST", body: new URLSearchParams({ password: "probe-test" }),
    });
    expect(login.status).toBe(204);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    await check({
      get: (path = "/api/probe") => realFetch(new URL(path, server.url), { headers: { cookie } }),
      post: (path, value) => realFetch(new URL(path, server.url), {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(value),
      }),
      anonymous: (path, method) => realFetch(new URL(path, server.url), { method }),
      raw: (body, contentType) => realFetch(new URL("/api/probe", server.url), {
        method: "POST", headers: { cookie, "content-type": contentType }, body,
      }),
      shutdown: probe.shutdown,
    });
  } finally {
    server.stop(true);
    await probe.shutdown();
    guardDb.close();
  }
}

test("protects the probe endpoints and validates start requests against the latest snapshot", () => withProbeServer(options, async (api) => {
  for (const [method, path] of [["GET", "/api/probe"], ["POST", "/api/probe"], ["POST", "/api/probe/cancel"]]) {
    const response = await api.anonymous(path, method);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  }
  const snapshot = await (await api.get("/api/status")).json() as StatusSnapshot;
  expect(snapshot).toMatchObject({ probeEnabled: true, dryRun: true, accounts: [{ id: 135, priorityBump: 2 }] });
  const empty = await api.get();
  expect(empty.status).toBe(200);
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({ run: null });

  for (const value of [null, [], {}, { ...probeRequest, accountIds: [] }, { ...probeRequest, accountIds: "135" },
    { ...probeRequest, accountIds: ["135"] }, { ...probeRequest, accountIds: [135, 135] }, { ...probeRequest, accountIds: [135, 146] },
    { ...probeRequest, accountIds: [135.1] }, { ...probeRequest, model: " " }, { ...probeRequest, prompt: "\n" },
    { ...probeRequest, repeat: 0 }, { ...probeRequest, repeat: 11 }, { ...probeRequest, repeat: 1.2 }, { ...probeRequest, repeat: "2" }]) {
    const response = await api.post("/api/probe", value);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "参数不对" });
  }
  expect((await api.raw("{", "application/json")).status).toBe(400);
  expect((await api.raw(JSON.stringify(probeRequest), "text/plain")).status).toBe(400);
  const cancel = await api.post("/api/probe/cancel");
  expect(cancel.status).toBe(409);
  expect(await cancel.json()).toEqual({ error: "没有正在跑的测试" });
}));

test.each(["adminApiKey", "probeApiKey"] as const)("disables web probes when %s is empty", (key) => withProbeServer({ ...options, [key]: "" }, async (api) => {
  expect(await (await api.get("/api/status")).json()).toMatchObject({ probeEnabled: false });
  const response = await api.post("/api/probe", probeRequest);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "请先在设置页填 Admin API Key 和 Probe API Key，才能测试" });
}));

test("starts with saved keys and group, keeps them in flight, and waits for restoration after cancel", async () => {
  const groupName = "页面自定义测试组";
  const secondRequest = Promise.withResolvers<void>();
  const restoreStarted = Promise.withResolvers<void>();
  const releaseRestore = Promise.withResolvers<void>();
  let requests = 0;
  const actions = mockSub2api((signal) => {
    if (++requests === 1) return completed();
    secondRequest.resolve();
    return new Promise((_, reject) => {
      signal!.throwIfAborted();
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    });
  }, {
    groupName,
    async beforeRestore() {
      restoreStarted.resolve();
      await releaseRestore.promise;
    },
  });
  await withProbeServer({ adminApiKey: "", probeApiKey: "" }, async (api) => {
    const read = async () => (await (await api.get()).json() as { run: ProbeRun }).run;
    try {
      expect((await api.post("/api/probe", probeRequest)).status).toBe(409);
      expect((await api.post("/api/keys", { admin: options.adminApiKey })).status).toBe(200);
      expect((await api.post("/api/probe", probeRequest)).status).toBe(409);
      expect((await api.post("/api/keys", { probe: options.probeApiKey })).status).toBe(200);
      expect((await api.post("/api/settings", { ...defaultSettings, probeGroupName: groupName })).status).toBe(200);
      const started = await api.post("/api/probe", probeRequest);
      expect(started.status).toBe(202);
      expect(await started.json()).toEqual({ id: 1 });
      await secondRequest.promise;
      const running = await read();
      expect(running).toMatchObject({ id: 1, request: probeRequest, startedAt: tickAt, finishedAt: null,
        error: null, exitCode: null, cancelled: false, results: [{ accountId: 135, requestNumber: 1, status: 200 }] });
      expect(running.logs).toEqual([
        { ts: tickAt, message: `Account 135 (test account): moving to ${groupName}` },
        { ts: tickAt, message: "Account 135: request 1/2" },
        { ts: tickAt, message: "Account 135: request 2/2" },
      ]);
      const overlap = await api.post("/api/probe", probeRequest);
      expect(overlap.status).toBe(409);
      expect(await overlap.json()).toEqual({ error: "已经有测试在跑，等它结束" });
      expect((await api.post("/api/keys", { admin: "new-admin-key", probe: "new-probe-key" })).status).toBe(200);
      expect((await api.post("/api/settings", { ...defaultSettings, probeGroupName: "下一次用的测试组" })).status).toBe(200);

      const cancel = await api.post("/api/probe/cancel");
      expect(cancel.status).toBe(204);
      expect(await cancel.text()).toBe("");
      await restoreStarted.promise;
      expect(await read()).toMatchObject({ cancelled: true, finishedAt: null, exitCode: null });
      expect((await api.post("/api/probe", probeRequest)).status).toBe(409);

      let stopped = false;
      const shutdown = api.shutdown().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      releaseRestore.resolve();
      await shutdown;
      const finished = await read();
      expect(finished).toMatchObject({ cancelled: true, finishedAt: tickAt, exitCode: 1, error: null,
        results: [{ requestNumber: 1 }, { requestNumber: 2, error: expect.any(String) }] });
      expect(actions).toEqual([move, "confirm group", "request", "request", { schedulable: true }, restore]);
      expect((await api.post("/api/probe/cancel")).status).toBe(409);
    } finally {
      releaseRestore.resolve();
    }
  });
});

async function runProbeCli(databasePath: string, baseUrl: string) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/probe.ts", import.meta.url)),
    "--model", options.model, "--prompt", options.prompt, "135"], {
    env: { SUB2API_URL: baseUrl, GUARD_DB: databasePath, PROBE_GROUP_NAME: "ignored-env-group", DATABASE_URL: "",
      ADMIN_API_KEY: "ignored-admin-key", PROBE_API_KEY: "ignored-probe-key" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("the CLI uses SQLite keys and group and prints progress, the results table, and full output", async () => {
  const groupName = "命令行自定义测试组";
  const actions = mockSub2api(
    () => new Response('data: {"type":"response.output_text.delta","delta":"Hello world"}\n\n'),
    { groupName },
  );
  const upstreamFetch = globalThis.fetch;
  globalThis.fetch = realFetch;
  const upstream = Bun.serve({ port: 0, async fetch(request) {
    return upstreamFetch(request.url, {
      method: request.method, headers: request.headers, signal: request.signal,
      body: request.body ? await request.text() : undefined,
    });
  } });
  const directory = await mkdtemp(join(tmpdir(), "sub2api-guard-probe-"));
  try {
    const path = join(directory, "guard.db");
    const db = openGuardDb(path, true);
    db.apiKeys.save({ admin: options.adminApiKey, probe: options.probeApiKey }, tickAt);
    db.settings.save({ ...defaultSettings, probeGroupName: groupName }, tickAt);
    db.close();
    const { stdout, stderr, exitCode } = await runProbeCli(path, upstream.url.href);
    expect(exitCode).toBe(0);
    expect(stderr).toBe(
      `Account 135 (test account): moving to ${groupName}\n` +
      "Account 135: request 1/1\n" +
      "Account 135: restoring scheduling and group bindings\n",
    );
    expect(stdout.replace(/\d+\.\d{3}/g, "0.000")).toBe(
      "Account  Name          Request #  HTTP  First-token s  Total s  Output / error\n" +
      "135      test account  1          200   0.000          0.000    Hello world\n\n" +
      "Account 135 (request 1)\nHello world\n",
    );
    expect(actions).toEqual([move, "confirm group", "request", { schedulable: true }, restore]);
  } finally {
    upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI reports missing stored keys without creating a database or using env keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sub2api-guard-probe-"));
  try {
    const path = join(directory, "guard.db");
    const unusedUrl = "http://127.0.0.1:0";
    const missingAdmin = { stdout: "", stderr: "Admin API Key is not set on the status page\n", exitCode: 1 };
    expect(await runProbeCli(path, unusedUrl)).toEqual(missingAdmin);
    expect(await Bun.file(path).exists()).toBe(false);
    await Bun.write(path, "");
    expect(await runProbeCli(path, unusedUrl)).toEqual(missingAdmin);
    expect(Bun.file(path).size).toBe(0);
    const db = openGuardDb(path, false);
    db.apiKeys.save({ admin: options.adminApiKey }, tickAt);
    db.close();
    expect(await runProbeCli(path, unusedUrl)).toEqual({
      stdout: "", stderr: "Probe API Key is not set on the status page\n", exitCode: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
