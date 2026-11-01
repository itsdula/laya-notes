import { useCallback, useEffect, useState } from "react";
import type { HealthReport } from "@shared/health.ts";
import { call, messageOf, subscribe } from "@/bridge.ts";

/** The startup report, kept current by events from the main process. */
export function useHealth(): { health: HealthReport | null; error: string | null; refresh: () => Promise<void> } {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setHealth(await call("health:get"));
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offs = [
      subscribe("health:changed", (next) => setHealth(next)),
      subscribe("model:changed", (model) => setHealth((current) => (current ? { ...current, model } : current))),
      subscribe("settings:changed", (settings) => setHealth((current) => (current ? { ...current, settings } : current))),
    ];
    return () => offs.forEach((off) => off());
  }, [refresh]);

  return { health, error, refresh };
}
