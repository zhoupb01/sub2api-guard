export const defaultGuardDbPath = "/data/guard.db";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.DATABASE_URL;
  const dryRun = env.DRY_RUN !== "0";
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  return {
    databaseUrl,
    sub2apiUrl: env.SUB2API_URL ?? "http://sub2api:8080",
    groupId: Number(env.GROUP_ID ?? 34),
    dryRun,
    guardDb: env.GUARD_DB ?? defaultGuardDbPath,
    webPort: Number(env.WEB_PORT ?? 8080),
    webPassword: env.WEB_PASSWORD ?? "",
  };
}
