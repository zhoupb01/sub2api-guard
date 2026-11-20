export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.DATABASE_URL;
  const dryRun = env.DRY_RUN !== "0";
  const adminApiKey = env.ADMIN_API_KEY ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!dryRun && !adminApiKey) throw new Error("ADMIN_API_KEY is required when DRY_RUN=0");

  return {
    databaseUrl,
    sub2apiUrl: env.SUB2API_URL ?? "http://sub2api:8080",
    adminApiKey,
    probeApiKey: env.PROBE_API_KEY ?? "",
    probeGroupName: env.PROBE_GROUP_NAME || "账号测试",
    groupId: Number(env.GROUP_ID ?? 34),
    tickSeconds: Number(env.TICK_SECONDS ?? 60),
    dryRun,
    barkUrl: env.BARK_URL,
    guardDb: env.GUARD_DB ?? "/data/guard.db",
    webPort: Number(env.WEB_PORT ?? 8080),
    webPassword: env.WEB_PASSWORD ?? "",
  };
}
