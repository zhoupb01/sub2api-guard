import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { createDatabase } from "../src/db";

test("groups each series table once with the same literal error match as tick traffic", async () => {
  const queries: { text: string; values: unknown[] }[] = [];
  type Fragment = { text: string; values: unknown[] };
  function sql(parts: TemplateStringsArray | string, ...values: unknown[]): Fragment {
    if (typeof parts === "string") return { text: parts, values: [] };
    const query: Fragment = { text: parts[0], values: [] };
    values.forEach((value, index) => {
      if (value !== null && typeof value === "object" && "text" in value && "values" in value) {
        const fragment = value as Fragment;
        query.text += fragment.text;
        query.values.push(...fragment.values);
      } else {
        query.text += "?";
        query.values.push(value);
      }
      query.text += parts[index + 1];
    });
    if (query.text.includes("FROM ops_error_logs") || query.text.includes("FROM usage_logs")) {
      queries.push(query);
      return [] as unknown as Fragment;
    }
    return query;
  }

  const db = createDatabase(sql as unknown as SQL, 34);
  const from = "2026-11-19T11:05:00.000Z";
  const to = "2026-11-19T12:03:14.123Z";
  await db.traffic([{ account_id: 1, since: from }], from, to, ["old"]);
  const [trafficErrors] = queries.splice(0);
  await db.series({ from, to, bucketMinutes: 5 }, [1, 2], ["NEW %_"]);
  expect(queries).toHaveLength(2);
  const [errors, successes] = queries;
  expect(errors.text).toContain("FROM ops_error_logs AS logs");
  expect(successes.text).toContain("FROM usage_logs AS logs");
  for (const { text, values } of queries) {
    expect(text).toContain("date_bin(?::int * interval '1 minute', logs.created_at::timestamptz, timestamptz 'epoch')");
    expect(text).toContain('GROUP BY logs.account_id, start');
    expect(text).toContain("WHERE logs.group_id = ?");
    expect(text).toContain("logs.account_id IN (");
    expect(text).toContain("logs.created_at >= ?::timestamptz");
    expect(text).toContain("logs.created_at <= ?::timestamptz");
    expect(values).toEqual(expect.arrayContaining([5, 34, "[1,2]", from, to]));
  }
  const match = /AND EXISTS \([\s\S]+?\n\s*\)/;
  expect(errors.text.match(match)?.[0]).toBe(trafficErrors.text.match(match)?.[0]);
  expect(errors.text).toContain("strpos(lower(logs.upstream_error_message), lower(patterns.pattern)) > 0");
  expect(errors.text).toContain("strpos(lower(logs.error_message), lower(patterns.pattern)) > 0");
  expect(errors.values).toContain('["NEW %_"]');
  expect(successes.text).not.toContain("strpos");
});
