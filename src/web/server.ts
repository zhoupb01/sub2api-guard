import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApiKeyUpdate } from "../guard-db";
import { isSeriesRange, type SeriesRange, type SeriesResponse } from "../series";
import { isSettings, type Settings } from "../settings";
import { createAuth, createLoginLimiter, expiredSessionCookie, sessionName } from "./auth";
import type { ProbeRunner } from "./probe-runner";
import type { ManualChange, StatusStore } from "./store";

export type ChangeAccount = (id: number, change: ManualChange) => Promise<"missing" | "disabled" | { error: string } | void>;

const noStore = { "cache-control": "no-store" };
const notFound = () => new Response("Not found", { status: 404 });

function html(body: BodyInit) {
  return new Response(body, {
    headers: {
      ...noStore,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function serveAsset(directory: string, encodedName: string) {
  try {
    const name = decodeURIComponent(encodedName);
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return notFound();
    const root = await realpath(directory);
    const path = await realpath(join(root, name));
    if (dirname(path) !== root) return notFound();
    const file = Bun.file(path);
    if (!(await file.exists())) return notFound();
    return new Response(file, { headers: {
      "content-type": file.type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    } });
  } catch {
    return notFound();
  }
}

function sessionResponse(cookie: string) {
  return new Response(null, { status: 204, headers: { ...noStore, "set-cookie": cookie } });
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return;
  return request.json().catch(() => null);
}

async function readManualChange(request: Request): Promise<ManualChange | undefined> {
  const body = await readJson(request);
  if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return;
  const entries = Object.entries(body);
  if (entries.length !== 1) return;
  const [[field, value]] = entries;
  if (field === "schedulable" && typeof value === "boolean") return { field, value };
  if (field === "loadFactor" && value === null) return { field, value };
  if (typeof value !== "number" || !Number.isInteger(value)) return;
  if (field === "concurrency" && value >= 1) return { field, value };
  if (field === "priority" && value >= 0) return { field, value };
  if (field === "loadFactor" && value >= 1 && value <= 10000) return { field, value };
}

async function readApiKeyUpdate(request: Request): Promise<ApiKeyUpdate | undefined> {
  const body = await readJson(request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const entries = Object.entries(body);
  if (!entries.length) return;
  const update: ApiKeyUpdate = {};
  for (const [field, value] of entries) {
    if (field !== "admin" && field !== "probe") return;
    const key: unknown = typeof value === "string" ? value.trim() : value;
    if (key !== null && (typeof key !== "string" || !key)) return;
    update[field] = key;
  }
  return update;
}

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

export function startStatusServer(store: StatusStore, port: number, password: string, {
  dist, changeAccount, saveSettings, saveApiKeys, series, probe, now = Date.now,
}: {
  dist: string;
  changeAccount: ChangeAccount;
  saveSettings: (settings: Settings) => Promise<void>;
  saveApiKeys: (update: ApiKeyUpdate) => Promise<void>;
  series: (range: SeriesRange) => Promise<SeriesResponse>;
  probe: ProbeRunner;
  now?: () => number;
}) {
  if (!password) throw new Error("WEB_PASSWORD is empty");
  const auth = createAuth(password);
  const attemptLogin = createLoginLimiter();
  return Bun.serve({
    port,
    // Bun matches the raw route before normalizing dot segments in request.url.
    routes: {
      "/assets/*": {
        GET(request) {
          const { pathname } = new URL(request.url);
          const prefix = "/assets/";
          return pathname.startsWith(prefix) ? serveAsset(join(dist, "assets"), pathname.slice(prefix.length)) : notFound();
        },
      },
    },
    async fetch(request, server) {
      const { pathname, searchParams } = new URL(request.url);
      const { method } = request;
      if (method === "GET" && pathname === "/") {
        const index = Bun.file(join(dist, "index.html"));
        return await index.exists() ? html(index) : notFound();
      }
      if (method === "POST" && pathname === "/login") {
        // Traefik appends the peer address after any client-supplied entries.
        const forwardedIp = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
        const ip = forwardedIp || server.requestIP(request)?.address || "";
        const form = await request.formData().catch(() => null);
        const candidate = form?.get("password");
        const requestedAt = now();
        const result = attemptLogin(ip, requestedAt, () => typeof candidate === "string" && auth.matchesPassword(candidate));
        if (result === "limited") return jsonError("试太多次了，15 分钟后再试", 429);
        if (result === "rejected") return jsonError("密码不对", 401);
        return sessionResponse(auth.sessionCookie(requestedAt));
      }
      if (method === "POST" && pathname === "/logout") return sessionResponse(expiredSessionCookie);
      const accountPath = method === "POST" && pathname.match(/^\/api\/accounts\/(\d+)$/);
      const statusRead = method === "GET" && pathname === "/api/status";
      const seriesRead = method === "GET" && pathname === "/api/series";
      const settingsWrite = method === "POST" && pathname === "/api/settings";
      const keysWrite = method === "POST" && pathname === "/api/keys";
      const probeRead = method === "GET" && pathname === "/api/probe";
      const probeStart = method === "POST" && pathname === "/api/probe";
      const probeCancel = method === "POST" && pathname === "/api/probe/cancel";
      if (accountPath || statusRead || seriesRead || settingsWrite || keysWrite || probeRead || probeStart || probeCancel) {
        const cookies = new Bun.CookieMap(request.headers.get("cookie") ?? "");
        const signedIn = auth.hasSession(cookies.get(sessionName), now());
        if (!signedIn) return jsonError("unauthorized", 401);
        if (statusRead) return Response.json(store.status(), { headers: noStore });
        if (probeRead || probeStart || probeCancel) {
          const { status, body } = probeRead ? probe.read()
            : probeStart ? probe.start(await readJson(request), store)
            : probe.cancel();
          return body === undefined ? new Response(null, { status, headers: noStore })
            : Response.json(body, { status, headers: noStore });
        }
        if (seriesRead) {
          const range = searchParams.get("range");
          if (!isSeriesRange(range)) return jsonError("参数不对", 400);
          return Response.json(await series(range), { headers: noStore });
        }
        if (settingsWrite) {
          const settings = await readJson(request);
          if (!isSettings(settings)) return jsonError("参数不对", 400);
          await saveSettings(settings);
          return Response.json({ ok: true }, { headers: noStore });
        }
        if (keysWrite) {
          const update = await readApiKeyUpdate(request);
          if (!update) return jsonError("参数不对", 400);
          await saveApiKeys(update);
          return Response.json({ ok: true }, { headers: noStore });
        }
        if (!accountPath) return notFound();
        const change = await readManualChange(request);
        if (!change) return jsonError("参数不对", 400);
        const result = await changeAccount(Number(accountPath[1]), change);
        if (result === "missing") return jsonError("账号不在列表里", 404);
        if (result === "disabled") return jsonError("请先在设置页填 Admin API Key，才能手动调整", 409);
        if (result) return jsonError(`sub2api 拒绝了修改：${result.error}`, 502);
        return Response.json({ ok: true }, { headers: noStore });
      }
      return notFound();
    },
  });
}
