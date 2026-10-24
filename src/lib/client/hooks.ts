"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AppSettings, Strategy } from "./types";

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [endpoints, setEndpoints] = useState<{ rest: string; ws: string } | null>(null);
  const reload = useCallback(() => {
    api<{ settings: AppSettings; endpoints: { rest: string; ws: string } }>("/api/settings").then((r) => {
      setSettings(r.settings);
      setEndpoints(r.endpoints);
    });
  }, []);
  useEffect(reload, [reload]);
  return { settings, endpoints, setSettings, reload };
}

export function useStrategies() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const reload = useCallback(() => {
    api<Strategy[]>("/api/strategies").then(setStrategies);
  }, []);
  useEffect(reload, [reload]);
  return { strategies, reload };
}

export interface Toast {
  id: number;
  kind: "error" | "warn" | "info";
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 5000);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return { toasts, push, dismiss };
}

/** Re-render every `ms` (used for "last update N s ago" displays). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      // Read after mount (not in the initializer) so server and client first renders match.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      /* storage unavailable */
    }
    loaded.current = true;
  }, [key]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
