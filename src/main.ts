import { sendBark } from "./bark";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { appendDecision, loadDecisions } from "./decision-log";
import { decide, decideReopens, minute, recentSince, trafficStats } from "./decide";
import { noChange, openState } from "./state";
import { openAdminApi } from "./sub2api";
import { startStatusServer } from "./web/server";
import { createStatusStore, type DecisionRecord } from "./web/store";

function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function logError(operation: string, error: unknown, fields: Record<string, unknown> = {}) {
  log("error", { operation, error: error instanceof Error ? error.message : String(error), ...fields });
}

async function run() {
  const config = loadConfig();
  const { policy, dryRun, barkUrl } = config;
  const database = openDatabase(config.databaseUrl, config.groupId, config.errorPatterns);
  const admin = dryRun ? undefined : openAdminApi(config.sub2apiUrl, config.adminApiKey);
  const initialDecisions = await loadDecisions(config.decisionLog, dryRun);
  const lastSummaryAt = new Map<number, number>();
  // A simulated close uses null and stays out of the open account list for this run.
  const simulated = new Map<number, number | null>();
  let loadedState: Awaited<ReturnType<typeof openState>> | undefined;
  const store = createStatusStore({ groupId: config.groupId, dryRun, policy, decisions: initialDecisions });
  try {
    startStatusServer(store, config.webPort, config.webPassword);
    log("web_server", { port: config.webPort });
  } catch (error) {
    logError("web_server", error, { port: config.webPort });
  }

  while (true) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    try {
      const state = loadedState ??= await openState(config.stateFile);
      await state.flush();

      const databaseAccounts = await database.accounts(nowIso);
      const openAccounts = databaseAccounts.filter((account) => simulated.get(account.id) !== null);
      for (const account of openAccounts) {
        if (state.get(account.id)?.closedAt !== undefined) await state.set(account.id, { closedAt: undefined });
      }
      const closedAccounts = dryRun
        ? databaseAccounts.filter((account) => simulated.get(account.id) === null && state.get(account.id)?.closedAt !== undefined)
        : (await database.closedAccounts(nowIso)).filter((account) => state.get(account.id)?.closedAt !== undefined);
      const accountData = [
        ...openAccounts.map((account) => ({ ...account, closed: false, closedAt: null as string | null })),
        ...closedAccounts.map((account) => ({
          ...account,
          closed: true,
          closedAt: state.get(account.id)?.closedAt ?? null,
        })),
      ];
      const snapshots = accountData.map((account) => {
        const recordedChangeAt = state.get(account.id)?.lastChangeAt;
        const lastChangeAt = recordedChangeAt === noChange ? undefined : recordedChangeAt;
        const since = new Date(recentSince(now, lastChangeAt, policy.windowMinutes)).toISOString();
        return {
          ...account,
          concurrency: simulated.get(account.id) ?? account.concurrency,
          lastChangeAt,
          since,
        };
      });
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
        await appendDecision(config.decisionLog, record);
        store.addDecision(record);

        if (admin) {
          try {
            await admin.setSchedulable(account.id, true);
          } catch (error) {
            logError("admin_api", error, { id: account.id, decision: "reopen" });
            continue;
          }
        } else {
          simulated.delete(account.id);
        }
        await state.set(account.id, { lastChangeAt: nowIso, closedAt: undefined });

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
        await appendDecision(config.decisionLog, record);
        store.addDecision(record);

        if (event !== "floor_blocked") {
          const nextCapacity = "concurrency" in decision ? decision.concurrency : null;
          if (admin) {
            try {
              if (nextCapacity === null) await admin.close(id);
              else await admin.setConcurrency(id, nextCapacity);
            } catch (error) {
              logError("admin_api", error, { id, decision: event });
              continue;
            }
          } else {
            simulated.set(id, nextCapacity);
          }
          await state.set(id, {
            lastChangeAt: nowIso,
            ...(event === "close" ? { closedAt: nowIso } : {}),
          });
        }

        if (dryRun || !barkUrl || (event !== "close" && event !== "floor_blocked")) continue;
        if (event === "floor_blocked") {
          const lastPushAt = state.get(id)?.lastFloorPushAt;
          if (lastPushAt !== undefined && now - Date.parse(lastPushAt) < 60 * minute) continue;
          await state.set(id, { lastFloorPushAt: nowIso });
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
      store.recordError(nowIso, error instanceof Error ? error.message : String(error));
    }
    await Bun.sleep(Math.max(0, config.tickSeconds * 1_000 - (Date.now() - now)));
  }
}

run().catch((error) => {
  logError("startup", error);
  process.exitCode = 1;
});
