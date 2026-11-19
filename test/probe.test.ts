import { afterEach, expect, mock, test } from "bun:test";
import { runProbe } from "../src/probe";

const options = {
  baseUrl: "https://sub2api.test",
  adminApiKey: "admin-test",
  probeApiKey: "sk-probe-test",
  groupName: "账号测试",
  accountIds: [135],
  model: "gpt-6.1-sol",
  prompt: "My custom prompt",
  repeat: 1,
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockSub2api(respond: (signal?: AbortSignal | null) => Response, {
  schedulable = true, failRestore = false, groupAccountCount = 1, createGroup = false,
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
        return success(createGroup ? [] : [{ id: 88, name: "账号测试", platform: "openai" }]);
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
