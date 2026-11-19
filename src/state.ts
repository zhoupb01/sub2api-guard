import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export const noChange = "1970-01-01T00:00:00.000Z";

interface Entry {
  lastChangeAt: string;
  lastFloorPushAt?: string;
}

type Entries = Record<string, Entry | undefined>;

export async function openState(path: string) {
  const file = Bun.file(path);
  const entries: Entries = await file.exists() ? await file.json() : {};
  let dirty = false;

  async function flush() {
    if (!dirty) return;
    const tempPath = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(tempPath, JSON.stringify(entries));
    await rename(tempPath, path);
    dirty = false;
  }

  return {
    get: (id: number): Entry | undefined => entries[id],
    async set(id: number, update: Partial<Entry>) {
      entries[id] = { lastChangeAt: noChange, ...entries[id], ...update };
      dirty = true;
      await flush();
    },
    flush,
  };
}
