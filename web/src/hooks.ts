import { useCallback, useEffect, useRef, useState } from "react";
import { Unauthorized } from "./api";

/** Polls a loader; keeps the last good value and reports the latest failure. */
export function usePoll<Data>(load: () => Promise<Data>, intervalMs: number, onUnauthorized: () => void, enabled = true) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  // A slow earlier request (say the 7-day range) must not overwrite a newer one.
  const latestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRef.current;
    try {
      const value = await loadRef.current();
      if (request !== latestRef.current) return;
      setData(value);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (failure) {
      if (request !== latestRef.current) return;
      if (failure instanceof Unauthorized) unauthorizedRef.current();
      else setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs, enabled]);

  return { data, error, updatedAt, refresh, setData };
}

export function useHash() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return hash;
}
