import { createAuth, createLoginLimiter, expiredSessionCookie, sessionName } from "./auth";
import type { ManualChange, StatusStore } from "./store";

export type ChangeAccount = (id: number, change: ManualChange) => Promise<"missing" | "disabled" | { error: string } | void>;

const pagePath = new URL("./index.html", import.meta.url);
const loginPath = new URL("./login.html", import.meta.url);
const noStore = { "cache-control": "no-store" };

function html(body: BodyInit, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...noStore,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function loginError(message: string, status: number) {
  const template = await Bun.file(loginPath).text();
  return html(template.replace("<!-- login-message -->", `<p class="feedback" role="alert">${message}</p>`), status);
}

function redirectHome(cookie: string) {
  return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie } });
}

async function readManualChange(request: Request): Promise<ManualChange | undefined> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return;
  const body: unknown = await request.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
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

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

export function startStatusServer(store: StatusStore, port: number, password: string, changeAccount: ChangeAccount, now = Date.now) {
  if (!password) throw new Error("WEB_PASSWORD is empty");
  const auth = createAuth(password);
  const attemptLogin = createLoginLimiter();
  return Bun.serve({
    port,
    async fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (request.method === "POST" && pathname === "/login") {
        // Traefik appends the peer address after any client-supplied entries.
        const forwardedIp = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
        const ip = forwardedIp || server.requestIP(request)?.address || "";
        const form = await request.formData().catch(() => null);
        const candidate = form?.get("password");
        const requestedAt = now();
        const result = attemptLogin(ip, requestedAt, () => typeof candidate === "string" && auth.matchesPassword(candidate));
        if (result === "limited") return loginError("试太多次了，15 分钟后再试", 429);
        if (result === "rejected") return loginError("密码不对", 401);
        return redirectHome(auth.sessionCookie(requestedAt));
      }
      if (request.method === "POST" && pathname === "/logout") return redirectHome(expiredSessionCookie);
      const accountPath = request.method === "POST" && pathname.match(/^\/api\/accounts\/(\d+)$/);
      if (accountPath || (request.method === "GET" && (pathname === "/" || pathname === "/api/status"))) {
        const cookies = new Bun.CookieMap(request.headers.get("cookie") ?? "");
        const signedIn = auth.hasSession(cookies.get(sessionName), now());
        if (pathname === "/") return html(Bun.file(signedIn ? pagePath : loginPath));
        if (!signedIn) return jsonError("unauthorized", 401);
        if (!accountPath) return Response.json(store.status(), { headers: noStore });

        const change = await readManualChange(request);
        if (!change) return jsonError("参数不对", 400);
        const result = await changeAccount(Number(accountPath[1]), change);
        if (result === "missing") return jsonError("账号不在列表里", 404);
        if (result === "disabled") return jsonError("没有设置 ADMIN_API_KEY，不能手动调整", 409);
        if (result) return jsonError(`sub2api 拒绝了修改：${result.error}`, 502);
        return Response.json({ ok: true }, { headers: noStore });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}
