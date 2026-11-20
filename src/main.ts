import { fileURLToPath } from "node:url";
import { sendBark } from "./bark";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { decide, decideReopens, minute, recentSince, trafficStats } from "./decide";
import { openGuardDb, type ApiKeyUpdate, type GuardDb } from "./guard-db";
import { createSeries } from "./series";
import type { Settings } from "./settings";
import { openAdminApi } from "./sub2api";
import { createProbeRunner } from "./web/probe-runner";
import { startStatusServer, type ChangeAccount } from "./web/server";
import { createStatusStore, type DecisionRecord, type RecordedAccount, type StatusStore } from "./web/store";

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function logError(operation: string, error: unknown, fields: Record<string, unknown> = {}) {
  log("error", { operation, error: errorMessage(error), ...fields });
}

interface SimulatedAccount {
  // Null represents a simulated close.
  concurrency?: number | null;
  priority?: number;
  actual: Pick<RecordedAccount, "concurrency" | "closed">;
}

export function createManualChange({ store, getAdmin, state, simulated, decisions, now = Date.now }: {
  store: StatusStore;
  getAdmin: () => ReturnType<typeof openAdminApi> | undefined;
  state: GuardDb["state"];
  simulated: Map<number, SimulatedAccount>;
  decisions: GuardDb["decisions"];
  now?: () => number;
}): ChangeAccount {
  const { dryRun } = store.status();
  return async (id, change) => {
    const account = store.getAccount(id);
    if (!account) return "missing";
    const admin = getAdmin();
    if (!admin) return "disabled";

    const { field, value } = change;
    try {
      switch (field) {
        case "concurrency": await admin.setConcurrency(id, value); break;
        case "priority": await admin.updateAccount(id, { priority: value }); break;
        case "loadFactor": await admin.updateAccount(id, { load_factor: value ?? 0 }); break;
        case "schedulable": await admin.setSchedulable(id, value); break;
      }
    } catch (error) {
      return { error: errorMessage(error) };
    }

    const ts = new Date(now()).toISOString();
    const simulation = simulated.get(id);
    const actual = simulation?.concurrency === undefined ? undefined : simulation.actual;
    let changes: Parameters<StatusStore["updateAccount"]>[1];
    switch (field) {
      case "concurrency": {
        state.set(id, { lastChangeAt: ts });
        if (simulation) simulation.concurrency = undefined;
        const closed = actual?.closed ?? account.closed;
        changes = { concurrency: value, lastChangeAt: ts, closed, closedAt: closed ? account.closedAt : null };
        break;
      }
      case "schedulable": {
        if (value) state.set(id, { lastChangeAt: ts, closedAt: undefined });
        else if (state.get(id)?.closedAt !== undefined) state.set(id, { closedAt: undefined });
        if (simulation) simulation.concurrency = undefined;
        changes = {
          concurrency: actual?.concurrency ?? account.concurrency,
          lastChangeAt: value ? ts : account.lastChangeAt,
          closed: !value,
          closedAt: null,
        };
        break;
      }
      case "priority":
        state.set(id, { priorityBump: 0 });
        if (simulation) simulation.priority = undefined;
        changes = { priority: value, priorityBump: 0 };
        break;
      case "loadFactor": changes = { loadFactor: value }; break;
    }

    const updated = store.updateAccount(account, changes);
    const record: DecisionRecord = {
      ts, event: "manual", id, name: account.name, concurrency: updated.concurrency,
      lastChangeAt: updated.lastChangeAt, dryRun, field,
      from: field === "schedulable" ? !account.closed : account[field],
      to: value,
    };
    store.addDecision(record);
    console.log(JSON.stringify(record));
    decisions.append(record);
  };
}

export function createGuard({ groupId, dryRun, database, sub2apiUrl, guardDb, now: clock = Date.now }: {
  groupId: number;
  sub2apiUrl: string;
  dryRun: boolean;
  database: Pick<ReturnType<typeof openDatabase>, "accounts" | "closedAccounts" | "traffic">;
  guardDb: GuardDb;
  now?: () => number;
}) {
  const { state, decisions, settings, apiKeys } = guardDb;
  const lastSummaryAt = new Map<number, number>();
  const simulated = new Map<number, SimulatedAccount>();
  const store = createStatusStore({
    groupId, dryRun, settings: settings.get(), getApiKeys: apiKeys.get, decisions: decisions.recent(200),
  });
  const getAdmin = () => {
    const { admin } = apiKeys.get();
    return admin ? openAdminApi(sub2apiUrl, admin) : undefined;
  };
  const changeAccount = createManualChange({ store, getAdmin, state, simulated, decisions, now: clock });

  // A tick uses one snapshot while changes wait in the same queue.
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => T | Promise<T>) {
    const result = pending.then(operation, operation);
    pending = result;
    return result;
  }

  async function tick() {
    const { value: policy } = store.getSettings();
    const now = clock();
    const nowIso = new Date(now).toISOString();
    try {
      const automaticAdmin = dryRun ? undefined : getAdmin();
      if (!dryRun && !automaticAdmin) throw new Error("实跑模式需要先在设置页填 Admin API Key");

      const accountData = [
        ...(await database.accounts(nowIso)).map((account) => ({ ...account, closed: false })),
        ...(await database.closedAccounts(nowIso)).map((account) => ({ ...account, closed: true })),
      ];
      const accountsById = new Map(accountData.map((account) => [account.id, account]));
      const snapshots = [];
      for (const account of accountsById.values()) {
        const simulation = simulated.get(account.id);
        if (simulation) simulation.actual = account;
        const closed = account.closed || simulation?.concurrency === null;
        if (!closed && state.get(account.id)?.closedAt !== undefined) {
          state.set(account.id, { closedAt: undefined });
        }
        const entry = state.get(account.id);
        const lastChangeAt = entry?.lastChangeAt;
        const priorityBump = entry?.priorityBump ?? 0;
        const since = new Date(recentSince(now, lastChangeAt, policy.windowMinutes)).toISOString();
        snapshots.push({
          ...account,
          closed,
          closedAt: closed ? entry?.closedAt ?? null : null,
          concurrency: simulation?.concurrency ?? account.concurrency,
          // A persisted dry-run bump has not been applied to sub2api's priority.
          priority: simulation?.priority ?? account.priority + (dryRun ? priorityBump : 0),
          priorityBump,
          lastChangeAt,
          since,
        });
      }
      const healthySince = new Date(now - policy.healthyMinutes * minute).toISOString();
      const windows = snapshots.map(({ id, since }) => ({ account_id: id, since }));
      const { errors, successes } = await database.traffic(windows, healthySince, nowIso, policy.errorPatterns);
      const samples = snapshots.map((account) => {
        const errorCounts = errors.get(account.id);
        const successCounts = successes.get(account.id);
        return {
          ...account,
          recent: { errors: Number(errorCounts?.recent ?? 0), successes: Number(successCounts?.recent ?? 0) },
          healthy: { errors: Number(errorCounts?.healthy ?? 0), successes: Number(successCounts?.healthy ?? 0) },
        };
      });
      const samplesById = new Map(samples.map((account) => [account.id, account]));
      store.recordTick({ now: nowIso, accounts: samples });

      for (const { id, concurrency, recent } of samples) {
        const previousSummary = lastSummaryAt.get(id);
        if (previousSummary === undefined || now - previousSummary >= 10 * minute) {
          log("account_summary", { id, concurrency, ...trafficStats(recent), dryRun });
          lastSummaryAt.set(id, now);
        }
      }

      const reopenCandidates = samples
        .filter((account) => account.closed && account.closedAt !== null)
        .map((account) => ({ id: account.id, closedAt: account.closedAt! }));
      for (const decision of decideReopens(now, reopenCandidates, policy.reopenMinutes)) {
        const account = samplesById.get(decision.accountId)!;
        const fields = {
          id: account.id,
          name: account.name,
          concurrency: account.concurrency,
          closedAt: decision.closedAt,
          reopenMinutes: policy.reopenMinutes,
          lastChangeAt: account.lastChangeAt ?? null,
          dryRun,
        };
        log("reopen", fields);
        const record: DecisionRecord = { ts: nowIso, event: "reopen", ...fields };
        decisions.append(record);
        store.addDecision(record);

        if (automaticAdmin) {
          try {
            await automaticAdmin.setSchedulable(account.id, true);
          } catch (error) {
            logError("admin_api", error, { id: account.id, decision: "reopen" });
            continue;
          }
        } else {
          const simulation = simulated.get(account.id);
          if (simulation) simulation.concurrency = undefined;
        }
        state.set(account.id, { lastChangeAt: nowIso, closedAt: undefined });

        const { barkUrl } = store.getSettings().value;
        if (dryRun || !barkUrl) continue;
        const hours = String(policy.reopenMinutes / 60);
        try {
          await sendBark(
            barkUrl,
            `恢复调度 #${account.id} ${account.name}`,
            `关闭 ${hours} 小时后自动恢复，容量 ${account.concurrency}`,
          );
        } catch (error) {
          logError("bark", error, { id: account.id, decision: "reopen" });
        }
      }

      const openSamples = samples.filter((account) => !account.closed);
      for (const decision of decide(now, openSamples, policy)) {
        const { accountId: id, event } = decision;
        const account = samplesById.get(id)!;
        const recovering = event === "increase" || event === "restore_priority";
        const since = recovering ? healthySince : account.since;
        const stats = trafficStats(recovering ? account.healthy : account.recent);
        const thresholds = recovering
          ? { maxConcurrency: decision.maxConcurrency, healthyMinutes: policy.healthyMinutes, healthyRate: policy.healthyRate }
          : { minRequests: policy.minRequests, errorRate: policy.errorRate, cooldownMinutes: policy.cooldownMinutes };
        const fields = {
          id,
          name: account.name,
          concurrency: account.concurrency,
          ...("concurrency" in decision ? { nextConcurrency: decision.concurrency } : {}),
          ...("priority" in decision ? { priority: account.priority, nextPriority: decision.priority } : {
            remainingUsable: decision.remainingUsable,
            minSchedulable: policy.minSchedulable,
          }),
          ...stats,
          ...thresholds,
          since,
          lastChangeAt: account.lastChangeAt ?? null,
          dryRun,
        };
        log(event, fields);
        const record: DecisionRecord = { ts: nowIso, event, ...fields };
        decisions.append(record);
        store.addDecision(record);

        if (event !== "floor_blocked") {
          const concurrency = "concurrency" in decision ? decision.concurrency : account.concurrency;
          if (automaticAdmin) {
            try {
              if (event === "close") await automaticAdmin.close(id);
              else await automaticAdmin.updateAccount(id, {
                concurrency,
                ...(decision.priority !== account.priority ? { priority: decision.priority } : {}),
              });
            } catch (error) {
              logError("admin_api", error, { id, decision: event });
              continue;
            }
          } else {
            simulated.set(id, {
              ...simulated.get(id), actual: accountsById.get(id)!,
              ...(event === "close" ? { concurrency: null } : {
                ...("concurrency" in decision ? { concurrency } : {}),
                priority: decision.priority,
              }),
            });
          }
          state.set(id, {
            lastChangeAt: nowIso,
            ...("priorityBump" in decision ? { priorityBump: decision.priorityBump } : { closedAt: nowIso }),
          });
        }

        if (dryRun || (event !== "close" && event !== "floor_blocked")) continue;
        const { barkUrl } = store.getSettings().value;
        if (!barkUrl) continue;
        if (event === "floor_blocked") {
          const lastPushAt = state.get(id)?.lastFloorPushAt;
          if (lastPushAt !== undefined && now - Date.parse(lastPushAt) < 60 * minute) continue;
          state.set(id, { lastFloorPushAt: nowIso });
        }
        const title = event === "close" ? "关闭调度" : "保留调度";
        const minutes = Number(((now - Date.parse(since)) / minute).toFixed(1));
        const prefix = event === "close" ? "" : `需保留至少 ${policy.minSchedulable} 个可用账号。`;
        const body = `${prefix}容量 ${account.concurrency} 仍报错：${minutes} 分钟 ${stats.errors} 错 / ${stats.total} 次（${(stats.rate * 100).toFixed(1)}%）`;
        try {
          await sendBark(barkUrl, `${title} #${id} ${account.name}`, body);
        } catch (error) {
          logError("bark", error, { id, decision: event });
        }
      }
    } catch (error) {
      logError("tick", error);
      store.recordError(nowIso, errorMessage(error));
    }
    return now;
  }

  let wakeTickWait: (() => void) | undefined;
  async function waitForNextTick(startedAt: number) {
    while (true) {
      const { tickSeconds } = store.getSettings().value;
      const remaining = startedAt + tickSeconds * 1_000 - clock();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wakeTickWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wakeTickWait = undefined;
    }
  }

  return {
    store,
    tick: () => serialize(tick),
    waitForNextTick,
    changeAccount: ((id, change) => serialize(() => changeAccount(id, change))) satisfies ChangeAccount,
    saveSettings: (value: Settings) => serialize(() => {
      const { value: from } = store.getSettings();
      const updatedAt = new Date(clock()).toISOString();
      settings.save(value, updatedAt);
      store.setSettings({ value, updatedAt });
      if (from.tickSeconds !== value.tickSeconds) wakeTickWait?.();
      // Bark URLs may contain a device key.
      const { barkUrl: _previousBarkUrl, ...previous } = from;
      const { barkUrl: _barkUrl, ...next } = value;
      console.log(JSON.stringify({ event: "settings", from: previous, to: next }));
    }),
    saveApiKeys: (update: ApiKeyUpdate) => serialize(() => {
      apiKeys.save(update, new Date(clock()).toISOString());
      const action = (value: string | null | undefined) => value === undefined ? "unchanged" : value === null ? "cleared" : "set";
      console.log(JSON.stringify({ event: "api_keys", admin: action(update.admin), probe: action(update.probe) }));
    }),
  };
}

async function run() {
  const config = loadConfig();
  const database = openDatabase(config.databaseUrl, config.groupId);
  const guardDb = openGuardDb(config.guardDb, config.dryRun);
  const probe = createProbeRunner({
    baseUrl: config.sub2apiUrl, getApiKeys: guardDb.apiKeys.get,
  });
  const guard = createGuard({ ...config, database, guardDb });
  const series = createSeries(guard.store, guardDb.decisions, database.series);
  const dist = fileURLToPath(new URL("../web/dist/", import.meta.url));
  let server: ReturnType<typeof startStatusServer> | undefined;
  try {
    server = startStatusServer(guard.store, config.webPort, config.webPassword, {
      ...guard, dist, series, probe,
    });
    log("web_server", { port: config.webPort });
  } catch (error) {
    logError("web_server", error, { port: config.webPort });
  }

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    server?.stop(true);
    await probe.shutdown();
    process.exit(0);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    const startedAt = await guard.tick();
    if (!stopping) await guard.waitForNextTick(startedAt);
  }
}

if (import.meta.main) {
  run().catch((error) => {
    logError("startup", error);
    process.exitCode = 1;
  });
}
