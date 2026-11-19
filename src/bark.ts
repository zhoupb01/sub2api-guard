export async function sendBark(url: string, title: string, body: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ title, body, group: "sub2api" }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    // The URL may contain the device key.
    throw new Error("Bark request failed");
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Bark HTTP ${response.status}`);
}
