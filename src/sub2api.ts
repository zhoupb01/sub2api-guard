export function openAdminApi(baseUrl: string, apiKey: string) {
  const accountsUrl = `${baseUrl.replace(/\/+$/, "")}/api/v1/admin/accounts`;

  async function post(path: string, body: object) {
    const response = await fetch(accountsUrl + path, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Admin API HTTP ${response.status}`);
    }
    const envelope = await response.json() as {
      code?: number;
      data?: { success_ids?: number[] };
    } | null;
    if (envelope?.code !== 0) throw new Error(`Admin API rejected request (code ${envelope?.code})`);
    return envelope.data;
  }

  return {
    async setConcurrency(id: number, concurrency: number) {
      // The individual PUT can rewrite account extra even when it is omitted.
      const result = await post("/bulk-update", { account_ids: [id], concurrency });
      if (!result?.success_ids?.includes(id)) throw new Error("Admin API did not report account update success");
    },
    async close(id: number) {
      await post(`/${id}/schedulable`, { schedulable: false });
    },
  };
}
