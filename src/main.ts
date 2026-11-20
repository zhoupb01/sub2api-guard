import { sendBark } from "./bark";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { decide, decideReopens, minute, recentSince, trafficStats } from "./decide";
import { openGuardDb, type GuardDb } from "./guard-db";
import { openAdminApi } from "./sub2api";
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
  concurrency: number | null;
  actual: Pick<RecordedAccount, "concurrency" | "closed">;
}

export function createManualChange({ store, admin, state, simulated, decisions }: {
  store: StatusStore;
  admin: ReturnType<typeof openAdminApi> | undefined;
  state: GuardDb["state"];
  simulated: Map<number, SimulatedAccount>;
  decisions: GuardDb["decisions"];
}): ChangeAccount {
  const { dryRun } = store.status();
  return async (id, change) => {
    const account = store.getAccount(id);
    if (!account) return "missing";
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

    const ts = new Date().toISOString();
    const actual = simulated.get(id)?.actual;
    let changes: Parameters<StatusStore["updateAccount"]>[1];
    switch (field) {
      case "concurrency": {
        state.set(id, { lastChangeAt: ts });
        simulated.delete(id);
        const closed = actual?.closed ?? account.closed;
        changes = { concurrency: value, lastChangeAt: ts, closed, closedAt: closed ? account.closedAt : null };
        break;
      }
      case "schedulable": {
        if (value) state.set(id, { lastChangeAt: ts, closedAt: undefined });
        else if (state.get(id)?.closedAt !== undefined) state.set(id, { closedAt: undefined });
        simulated.delete(id);
        changes = {
          concurrency: actual?.concurrency ?? account.concurrency,
          lastChangeAt: value ? ts : account.lastChangeAt,
          closed: !value,
          closedAt: null,
        };
        break;
      }
      case "priority": changes = { priority: value }; break;
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

async function run() {
  const config = loadConfig();
  const { policy, dryRun, barkUrl } = config;
  const database = openDatabase(config.databaseUrl, config.groupId, config.errorPatterns);
  const admin = config.adminApiKey ? openAdminApi(config.sub2apiUrl, config.adminApiKey) : undefined;
  const automaticAdmin = dryRun ? undefined : admin;
  const { state, decisions } = openGuardDb(config.guardDb, dryRun);
  const lastSummaryAt = new Map<number, number>();
  const simulated = new Map<number, SimulatedAccount>();
  const store = createStatusStore({ groupId: config.groupId, dryRun, policy, manualEnabled: admin !== undefined, decisions: decisions.recent(200) });
  const changeAccount = createManualChange({ store, admin, state, simulated, decisions });

  // A tick must finish using its snapshot before a manual change can replace it.
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>) {
    const result = pending.then(operation, operation);
    pending = result;
    return result;
  }

  try {
    startStatusServer(store, config.webPort, config.webPassword, (id, change) => serialize(() => changeAccount(id, change)));
    log("web_server", { port: config.webPort });
  } catch (error) {
    logError("web_server", error, { port: config.webPort });
  }

  async function tick() {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    try {
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
        const since = new Date(recentSince(now, lastChangeAt, policy.windowMinutes)).toISOString();
        snapshots.push({
          ...account,
          closed,
          closedAt: closed ? entry?.closedAt ?? null : null,
          concurrency: simulation?.concurrency ?? account.concurrency,
          lastChangeAt,
          since,
        });
      }
      const healthySince = new Date(now - policy.healthyMinutes * minute).toISOString();
      const windows = snapshots.map(({ id, since }) => ({ account_id: id, since }));
      const { errors, successes } = await database.traffic(windows, healthySince, nowIso);
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
          simulated.delete(account.id);
        }
        state.set(account.id, { lastChangeAt: nowIso, closedAt: undefined });

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
        const since = event === "increase" ? healthySince : account.since;
        const stats = trafficStats(event === "increase" ? account.healthy : account.recent);
        const thresholds = event === "increase"
          ? { maxConcurrency: decision.maxConcurrency, healthyMinutes: policy.healthyMinutes, healthyRate: policy.healthyRate }
          : { minRequests: policy.minRequests, errorRate: policy.errorRate, cooldownMinutes: policy.cooldownMinutes };
        const fields = {
          id,
          name: account.name,
          concurrency: account.concurrency,
          ...("concurrency" in decision ? { nextConcurrency: decision.concurrency } : {
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
          const nextCapacity = "concurrency" in decision ? decision.concurrency : null;
          if (automaticAdmin) {
            try {
              if (nextCapacity === null) await automaticAdmin.close(id);
              else await automaticAdmin.setConcurrency(id, nextCapacity);
            } catch (error) {
              logError("admin_api", error, { id, decision: event });
              continue;
            }
          } else {
            simulated.set(id, { concurrency: nextCapacity, actual: accountsById.get(id)! });
          }
          state.set(id, {
            lastChangeAt: nowIso,
            ...(event === "close" ? { closedAt: nowIso } : {}),
          });
        }

        if (dryRun || !barkUrl || (event !== "close" && event !== "floor_blocked")) continue;
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

  while (true) {
    const now = await serialize(tick);
    await Bun.sleep(Math.max(0, config.tickSeconds * 1_000 - (Date.now() - now)));
  }
}

if (import.meta.main) {
  run().catch((error) => {
    logError("startup", error);
    process.exitCode = 1;
  });
}
