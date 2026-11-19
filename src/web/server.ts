import type { StatusStore } from "./store";

const pagePath = new URL("./index.html", import.meta.url);

export function startStatusServer(store: StatusStore, port: number) {
  return Bun.serve({
    port,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/") {
        return new Response(Bun.file(pagePath), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (pathname === "/api/status") {
        return Response.json(store.status(), { headers: { "cache-control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}
