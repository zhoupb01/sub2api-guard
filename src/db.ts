import { SQL } from "bun";
import type { SeriesCount, SeriesWindow } from "./series";

interface Account {
  id: number;
  name: string;
  concurrency: number;
  priority: number;
  loadFactor: number | null;
  usable: boolean;
}

interface AccountWindow {
  account_id: number;
  since: string;
}

interface Counts {
  accountId: number;
  recent: number | string;
  healthy: number | string;
}

export function openDatabase(url: string, groupId: number) {
  return createDatabase(new SQL({ url, connection: { default_transaction_read_only: "on" } }), groupId);
}

export function createDatabase(sql: SQL, groupId: number) {
  type LogTable = "ops_error_logs" | "usage_logs";
  function matchError(table: LogTable, patterns: string) {
    return table === "ops_error_logs" ? sql`
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${patterns}::text::jsonb) AS patterns(pattern)
        WHERE strpos(lower(logs.upstream_error_message), lower(patterns.pattern)) > 0
           OR strpos(lower(logs.error_message), lower(patterns.pattern)) > 0
      )
    ` : sql``;
  }

  async function accountsByScheduling(now: string, schedulable: boolean): Promise<Account[]> {
    const rows = await sql<Account[]>`
      SELECT a.id, a.name, a.concurrency, a.priority, a.load_factor AS "loadFactor",
             COALESCE(GREATEST(a.temp_unschedulable_until, a.rate_limit_reset_at, a.overload_until)
                      <= ${now}::timestamptz, true) AS usable
      FROM accounts AS a
      JOIN account_groups AS ag ON ag.account_id = a.id
      WHERE ag.group_id = ${groupId}
        AND a.deleted_at IS NULL
        AND a.parent_account_id IS NULL
        AND a.status = 'active'
        AND a.schedulable = ${schedulable}
      ORDER BY a.id
    `;
    return rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  return {
    accounts: (now: string) => accountsByScheduling(now, true),
    closedAccounts: (now: string) => accountsByScheduling(now, false),

    async traffic(windows: AccountWindow[], healthySince: string, now: string, errorPatterns: string[]) {
      // Bind JSON strings as text so Bun does not encode them as JSON strings again.
      const accountWindows = JSON.stringify(windows);
      const patterns = JSON.stringify(errorPatterns);
      const count = (table: LogTable) => {
        return sql<Counts[]>`
          WITH bounds AS (SELECT ${healthySince}::timestamptz AS healthy_since)
          SELECT logs.account_id AS "accountId",
                 count(*) FILTER (WHERE logs.created_at >= windows.since) AS recent,
                 count(*) FILTER (WHERE logs.created_at >= bounds.healthy_since) AS healthy
          FROM ${sql(table)} AS logs
          JOIN jsonb_to_recordset(${accountWindows}::text::jsonb) AS windows(account_id bigint, since timestamptz)
            ON windows.account_id = logs.account_id
          CROSS JOIN bounds
          WHERE logs.group_id = ${groupId}
            AND logs.created_at >= LEAST(windows.since, bounds.healthy_since)
            AND logs.created_at <= ${now}::timestamptz
            ${matchError(table, patterns)}
          GROUP BY logs.account_id
        `;
      };
      const [errors, successes] = await Promise.all([count("ops_error_logs"), count("usage_logs")]);
      const byAccount = (rows: Counts[]) => new Map(rows.map((row) => [Number(row.accountId), row]));
      return { errors: byAccount(errors), successes: byAccount(successes) };
    },

    async series({ from, to, bucketMinutes }: SeriesWindow, ids: number[], errorPatterns: string[]) {
      const accountIds = JSON.stringify(ids);
      const patterns = JSON.stringify(errorPatterns);
      const count = (table: LogTable) => sql<SeriesCount[]>`
        SELECT logs.account_id AS "accountId",
               extract(epoch FROM date_bin(${bucketMinutes}::int * interval '1 minute', logs.created_at::timestamptz, timestamptz 'epoch')) * 1000 AS start,
               count(*) AS count
        FROM ${sql(table)} AS logs
        WHERE logs.group_id = ${groupId}
          AND logs.account_id IN (
            SELECT value::bigint FROM jsonb_array_elements_text(${accountIds}::text::jsonb) AS ids(value)
          )
          AND logs.created_at >= ${from}::timestamptz
          AND logs.created_at <= ${to}::timestamptz
          ${matchError(table, patterns)}
        GROUP BY logs.account_id, start
      `;
      const [errors, successes] = await Promise.all([count("ops_error_logs"), count("usage_logs")]);
      return { errors, successes };
    },
  };
}
