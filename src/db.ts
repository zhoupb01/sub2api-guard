import { SQL } from "bun";

interface Account {
  id: number;
  name: string;
  concurrency: number;
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

export function openDatabase(url: string, groupId: number, errorPatterns: string[]) {
  const sql = new SQL({ url, connection: { default_transaction_read_only: "on" } });
  const patterns = JSON.stringify(errorPatterns);

  return {
    async accounts(now: string): Promise<Account[]> {
      const rows = await sql<Account[]>`
        SELECT a.id, a.name, a.concurrency,
               COALESCE(GREATEST(a.temp_unschedulable_until, a.rate_limit_reset_at, a.overload_until)
                        <= ${now}::timestamptz, true) AS usable
        FROM accounts AS a
        JOIN account_groups AS ag ON ag.account_id = a.id
        WHERE ag.group_id = ${groupId}
          AND a.deleted_at IS NULL
          AND a.parent_account_id IS NULL
          AND a.status = 'active'
          AND a.schedulable = true
        ORDER BY a.id
      `;
      return rows.map((row) => ({ ...row, id: Number(row.id) }));
    },

    async closedAccounts(now: string): Promise<Account[]> {
      const rows = await sql<Account[]>`
        SELECT a.id, a.name, a.concurrency,
               COALESCE(GREATEST(a.temp_unschedulable_until, a.rate_limit_reset_at, a.overload_until)
                        <= ${now}::timestamptz, true) AS usable
        FROM accounts AS a
        JOIN account_groups AS ag ON ag.account_id = a.id
        WHERE ag.group_id = ${groupId}
          AND a.deleted_at IS NULL
          AND a.parent_account_id IS NULL
          AND a.status = 'active'
          AND a.schedulable = false
        ORDER BY a.id
      `;
      return rows.map((row) => ({ ...row, id: Number(row.id) }));
    },

    async traffic(windows: AccountWindow[], healthySince: string, now: string) {
      // Bind JSON strings as text so Bun does not encode them as JSON strings again.
      const accountWindows = JSON.stringify(windows);
      const count = (table: "ops_error_logs" | "usage_logs") => {
        const matchError = table === "ops_error_logs" ? sql`
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${patterns}::text::jsonb) AS patterns(pattern)
            WHERE strpos(lower(logs.upstream_error_message), lower(patterns.pattern)) > 0
               OR strpos(lower(logs.error_message), lower(patterns.pattern)) > 0
          )
        ` : sql``;
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
            ${matchError}
          GROUP BY logs.account_id
        `;
      };
      const [errors, successes] = await Promise.all([count("ops_error_logs"), count("usage_logs")]);
      const byAccount = (rows: Counts[]) => new Map(rows.map((row) => [Number(row.accountId), row]));
      return { errors: byAccount(errors), successes: byAccount(successes) };
    },
  };
}
