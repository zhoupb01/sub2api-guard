type Page<Item> = { items: Item[]; pages: number; total: number };
type Group = { id: number; name: string; platform: string };
type ApiKey = { id: number; key: string; group_id: number | null };
type Account = { id: number; name: string; group_ids?: number[]; schedulable: boolean };

export function openAdminApi(baseUrl: string, apiKey: string) {
  const adminUrl = `${baseUrl.replace(/\/+$/, "")}/api/v1/admin`;

  async function request<Data>(method: "GET" | "POST" | "PUT", path: string, body?: object) {
    const response = await fetch(adminUrl + path, {
      method,
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Admin API HTTP ${response.status}`);
    }
    const envelope = await response.json() as {
      code?: number;
      data: Data;
    } | null;
    if (envelope?.code !== 0) throw new Error(`Admin API rejected request (code ${envelope?.code})`);
    return envelope.data;
  }

  async function updateAccount(id: number, changes: { concurrency: number } | { group_ids: number[] }) {
    // The individual PUT can rewrite account extra even when it is omitted.
    const result = await request<{ success_ids?: number[] }>("POST", "/accounts/bulk-update", {
      account_ids: [id], ...changes,
    });
    if (!result?.success_ids?.includes(id)) throw new Error("Admin API did not report account update success");
  }

  async function setSchedulable(id: number, schedulable: boolean) {
    await request("POST", `/accounts/${id}/schedulable`, { schedulable });
  }

  async function* listPages<Item>(path: string) {
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const data = await request<Page<Item>>("GET", `${path}${separator}page=${page}&page_size=100`);
      yield* data.items;
      if (page >= data.pages) break;
    }
  }

  return {
    setConcurrency: (id: number, concurrency: number) => updateAccount(id, { concurrency }),
    close: (id: number) => setSchedulable(id, false),
    setSchedulable,
    setGroups: (id: number, groupIds: number[]) => updateAccount(id, { group_ids: groupIds }),
    getAccount: (id: number) => request<Account>("GET", `/accounts/${id}`),
    async isOnlyGroupAccount(groupId: number, accountId: number) {
      const { items, total } = await request<Page<{ id: number }>>(
        "GET", `/accounts?group=${groupId}&page_size=1&lite=true`,
      );
      return total === 1 && items[0]?.id === accountId;
    },
    async getOrCreateProbeGroup(name: string) {
      const groups = await request<Group[]>("GET", "/groups/all?include_inactive=true");
      return groups.find((group) => group.name === name && group.platform === "openai")
        ?? await request<Group>("POST", "/groups", {
          name, platform: "openai", is_exclusive: true, rate_multiplier: 1,
        });
    },
    async bindProbeKey(value: string, groupId: number, signal: AbortSignal) {
      // The usage search matches key names. The per-user endpoint returns full keys.
      for await (const user of listPages<{ id: number }>("/users?include_subscriptions=false")) {
        signal.throwIfAborted();
        for await (const key of listPages<ApiKey>(`/users/${user.id}/api-keys`)) {
          signal.throwIfAborted();
          if (key.key !== value) continue;
          if (key.group_id !== groupId) await request("PUT", `/api-keys/${key.id}`, { group_id: groupId });
          return;
        }
      }
      throw new Error("PROBE_API_KEY was not found in sub2api");
    },
  };
}
