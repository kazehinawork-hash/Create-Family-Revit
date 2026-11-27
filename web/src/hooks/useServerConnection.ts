import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHealth, pingServer, type Health } from "../lib/api";

/** Tracks local API reachability (`ping`) and available backends/models (`health`). */
export function useServerConnection(onHealth?: (result: Health) => void) {
  const [health, setHealth] = useState<Health | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const serverOnlineRef = useRef<boolean | null>(null);
  const onHealthRef = useRef(onHealth);
  onHealthRef.current = onHealth;

  const refreshHealth = useCallback(async () => {
    const result = await fetchHealth();
    if (result) {
      setHealth(result);
      onHealthRef.current?.(result);
    }
    return result;
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let delay = 500;

    const attempt = async () => {
      if (!alive) return;
      const result = await refreshHealth();
      if (!alive) return;

      if (result) {
        delay = 500;
        timer = window.setTimeout(attempt, 60000);
        return;
      }

      timer = window.setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 30000);
    };

    void attempt();

    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshHealth]);

  useEffect(() => {
    let alive = true;

    const probe = async () => {
      const ping = await pingServer();
      if (!alive) return;

      const online = Boolean(ping?.ok);
      const wasOnline = serverOnlineRef.current;
      serverOnlineRef.current = online;
      setServerOnline(online);

      if (online && wasOnline === false) {
        void refreshHealth();
      }
    };

    void probe();
    const timer = window.setInterval(probe, 5000);
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshHealth]);

  return { health, serverOnline, setServerOnline, refreshHealth };
}
