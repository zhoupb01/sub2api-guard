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
    groupId: Number(env.GROUP_ID ?? 34),
    tickSeconds: Number(env.TICK_SECONDS ?? 60),
    dryRun,
    barkUrl: env.BARK_URL,
    stateFile: env.STATE_FILE ?? "/data/state.json",
    webPort: Number(env.WEB_PORT ?? 8080),
    errorPatterns: JSON.parse(env.ERROR_PATTERNS ?? '["overloaded","Concurrency limit exceeded for account"]') as string[],
    policy: {
      maxConcurrency: Number(env.MAX_CONCURRENCY ?? 3),
      maxOverrides: JSON.parse(env.MAX_OVERRIDES ?? "{}") as Record<string, number>,
      windowMinutes: Number(env.WINDOW_MIN ?? 10),
      minRequests: Number(env.MIN_REQUESTS ?? 20),
      errorRate: Number(env.ERROR_RATE ?? 0.05),
      cooldownMinutes: Number(env.COOLDOWN_MIN ?? 10),
      healthyMinutes: Number(env.HEALTHY_MIN ?? 30),
      healthyRate: Number(env.HEALTHY_RATE ?? 0.01),
      minSchedulable: Number(env.MIN_SCHEDULABLE ?? 4),
    },
  };
}
