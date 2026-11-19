import { createAuth, createLoginLimiter, expiredSessionCookie, sessionName } from "./auth";
import type { StatusStore } from "./store";

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

export function startStatusServer(store: StatusStore, port: number, password: string, now = Date.now) {
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
      if (request.method === "GET" && (pathname === "/" || pathname === "/api/status")) {
        const cookies = new Bun.CookieMap(request.headers.get("cookie") ?? "");
        const signedIn = auth.hasSession(cookies.get(sessionName), now());
        if (pathname === "/") return html(Bun.file(signedIn ? pagePath : loginPath));
        return signedIn
          ? Response.json(store.status(), { headers: noStore })
          : Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}
