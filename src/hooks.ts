import { useCallback, useEffect, useRef, useState } from 'react';

export type Remote<T> = { data: T | null; error: string | null; loading: boolean; refreshing: boolean; fetchedAt: string | null; reload: () => void };

export function useRemote<T>(loader: () => Promise<T>, key: string, pollMs = 0): Remote<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const lastKey = useRef<string | null>(null);
  const reload = useCallback(() => setTick(v => v + 1), []);

  useEffect(() => {
    let alive = true;
    let busy = false;
    let failures = 0;
    let timer: number | undefined;
    const run = async () => {
      if (busy || document.hidden) return;
      busy = true;
      setRefreshing(true);
      try {
        const result = await loader();
        if (alive) { failures = 0; setData(result); setError(null); setFetchedAt(new Date().toISOString()); }
      } catch (cause) {
        if (alive) { failures++; setError(cause instanceof Error ? cause.message : 'No se pudo consultar la API.'); }
      } finally {
        busy = false;
        if (alive) { setLoading(false); setRefreshing(false); }
        if (alive && pollMs) { if(timer)window.clearTimeout(timer); timer=window.setTimeout(()=>void run(),Math.min(180_000,pollMs*2**Math.min(failures,2))); }
      }
    };
    if(lastKey.current !== key) { setLoading(true); setData(null); lastKey.current = key; }
    setError(null);
    void run();
    const onVisible = () => { if (!document.hidden) void run(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); if (timer) window.clearTimeout(timer); };
    // loader is intentionally represented by the stable serialized key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, pollMs]);
  return { data, error, loading, refreshing, fetchedAt, reload };
}
