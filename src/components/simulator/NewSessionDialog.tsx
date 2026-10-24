"use client";

import { useEffect, useState } from "react";
import { MarketPicker, useMarkets } from "@/components/MarketPicker";
import type { CostModel } from "@/lib/engine/types";
import { TIMEFRAMES, timeframeMs } from "@/lib/market/timeframes";
import { api } from "@/lib/client/api";
import type { AppSettings, SessionView, Strategy } from "@/lib/client/types";

interface Dataset {
  dataset: { id: number; timeframe: string; label: string; sourceId: string; firstTime: number | null; lastTime: number | null; candleCount: number };
  symbol: string;
}

interface ProviderCaps {
  id: string;
  name: string;
  timeframes: string[];
  verification: string;
  notes: string[];
  licensing: string;
  rateLimit: string;
}

interface Job {
  id: string;
  status: "running" | "done" | "error";
  progress: number;
  error: string | null;
}

const MAX_BARS = 250_000;
const COST_FIELDS: [keyof CostModel, string, number][] = [
  ["makerFeeBps", "Maker fee (bps)", 0.5],
  ["takerFeeBps", "Taker fee (bps)", 0.5],
  ["spreadBps", "Spread (bps)", 0.1],
  ["slippageBps", "Slippage (bps)", 0.1],
  ["commissionPerUnit", "Commission / unit / side", 0.5],
];
const day = (d: Date) => d.toISOString().slice(0, 10);

export function NewSessionDialog({ settings, strategies, onCreated, onClose }: { settings: AppSettings; strategies: Strategy[]; onCreated: (v: SessionView) => void; onClose: () => void }) {
  const markets = useMarkets();
  const [source, setSource] = useState<"provider" | "csv">("provider");
  const [symbol, setSymbol] = useState(settings.defaultSymbol);
  const [timeframe, setTimeframe] = useState(settings.defaultTimeframe === "1m" ? "15m" : settings.defaultTimeframe);
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 60 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date(Date.now() - 30 * 86_400_000)));
  const [today] = useState(() => day(new Date()));
  const [balance, setBalance] = useState(10_000);
  const [risk, setRisk] = useState(settings.riskPercent);
  const [strategyId, setStrategyId] = useState<number | null>(null);
  const [costs, setCosts] = useState<CostModel>(settings.costs);
  const [costsTouched, setCostsTouched] = useState(false);
  const [leverage, setLeverage] = useState<number | null>(null);
  const [resolveLowerTf, setResolve] = useState(true);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderCaps[]>([]);

  useEffect(() => {
    api<Dataset[]>("/api/datasets")
      .then((d) => setDatasets(d.filter((x) => x.dataset.sourceId === "csv")))
      .catch(() => {});
    api<{ providers: ProviderCaps[] }>("/api/markets")
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  }, []);

  const inst = markets?.instruments.find((i) => i.symbol === symbol);
  const providerId = inst?.historical.provider ?? (source === "provider" && !inst ? "auto" : null);
  const caps = providers.find((p) => p.id === providerId);
  const timeframes = caps?.timeframes ?? TIMEFRAMES;
  const assetClass = inst?.assetClass ?? "crypto";
  const classCosts = settings.costsByAssetClass?.[assetClass] ?? settings.costs;
  const shownCosts = costsTouched ? costs : classCosts;
  const shownLeverage = leverage ?? inst?.leverage ?? 1;

  const chooseSymbol = (s: string) => {
    setSymbol(s);
    setCostsTouched(false);
    setLeverage(null);
    const next = markets?.instruments.find((i) => i.symbol === s);
    const tfs = providers.find((p) => p.id === next?.historical.provider)?.timeframes;
    if (tfs && !tfs.includes(timeframe)) setTimeframe(tfs.includes("1h") ? "1h" : tfs[0]);
  };

  const chooseDataset = (id: number | null) => {
    setDatasetId(id);
    const ds = datasets.find((d) => d.dataset.id === id);
    if (ds?.dataset.firstTime && ds.dataset.lastTime) {
      setTimeframe(ds.dataset.timeframe);
      setFrom(day(new Date(ds.dataset.firstTime)));
      setTo(day(new Date(ds.dataset.lastTime)));
    }
  };

  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T23:59:59Z`);
  const bars = Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.floor((toMs - fromMs) / timeframeMs(timeframe)) : 0;
  const tooMany = bars > MAX_BARS;
  const slowMinute = providerId === "dukascopy" && timeframeMs(timeframe) < 3_600_000 && toMs - fromMs > 31 * 86_400_000;
  const unavailable = source === "provider" && inst && !inst.historical.provider ? inst.historical.reason : null;

  const notes = caps ? caps.notes.slice(0, 2) : [];

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const end = Math.min(toMs, Date.now() - 1);
      if (source === "provider") {
        // Download first (background job with progress), then create the session from cache.
        let j = await api<Job>("/api/data/downloads", { method: "POST", json: { symbol, provider: providerId ?? "auto", timeframe, from: fromMs, to: end } });
        setJob(j);
        while (j.status === "running") {
          await new Promise((r) => setTimeout(r, 800));
          j = await api<Job>(`/api/data/downloads/${j.id}`);
          setJob(j);
        }
        if (j.status === "error") throw new Error(j.error ?? "Download failed");
      }
      const v = await api<SessionView>("/api/sessions", {
        method: "POST",
        json: {
          name: name || undefined,
          source: source === "csv" ? "csv" : (providerId ?? "auto"),
          symbol: source === "provider" ? symbol : undefined,
          datasetId: source === "csv" ? datasetId : undefined,
          timeframe,
          from: fromMs,
          to: end,
          startingBalance: balance,
          riskPercent: risk,
          strategyId,
          costs: shownCosts,
          leverage: shownLeverage,
          resolveLowerTf: providerId === "binance" ? resolveLowerTf : false,
        },
      });
      onCreated(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setJob(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/60 md:place-items-center md:p-4" onMouseDown={onClose}>
      <div
        className="panel max-h-[92vh] w-full overflow-y-auto rounded-b-none p-4 pb-[calc(16px+env(safe-area-inset-bottom))] md:max-w-2xl md:rounded-b-lg md:p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold">New backtest session</h2>
        <p className="mb-4 text-[12px] text-muted">Replays real historical candles bar by bar. Future candles stay hidden until you step forward.</p>

        <div className="mb-3 flex gap-1 rounded-md bg-bg p-0.5">
          {(["provider", "csv"] as const).map((s) => (
            <button key={s} onClick={() => setSource(s)} className={`flex-1 rounded py-1.5 ${source === s ? "bg-raised text-ink" : "text-muted"}`}>
              {s === "provider" ? "Market data provider" : "Imported CSV"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {source === "provider" ? (
            <label className="sm:col-span-2">
              <span className="label">Market & instrument</span>
              <MarketPicker mode="historical" value={symbol} onChange={chooseSymbol} className="w-full" />
              {inst?.historical.provider && caps && (
                <span className="mt-1 block text-[11px] text-muted">
                  Data: {caps.name}
                  {caps.verification !== "verified" && <span className="text-warn"> · adapter unverified</span>}
                  {notes.length > 0 && ` · ${notes[0]}`}
                </span>
              )}
              {unavailable && <span className="mt-1 block text-[12px] text-warn">{unavailable}</span>}
            </label>
          ) : (
            <label className="sm:col-span-2">
              <span className="label">Dataset</span>
              <select className="input" value={datasetId ?? ""} onChange={(e) => chooseDataset(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Choose…</option>
                {datasets.map((d) => (
                  <option key={d.dataset.id} value={d.dataset.id}>
                    {d.symbol} {d.dataset.timeframe} · {d.dataset.label} ({d.dataset.candleCount})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="label">Timeframe</span>
            <select className="input" value={timeframe} disabled={source === "csv"} onChange={(e) => setTimeframe(e.target.value)}>
              {timeframes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="label">Strategy tag</span>
            <select className="input" value={strategyId ?? ""} onChange={(e) => setStrategyId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None</option>
              {strategies
                .filter((s) => !s.archived)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span className="label">From (UTC)</span>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className="label">To (UTC)</span>
            <input className="input" type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <span className="label">Starting balance ({assetClass === "crypto" ? "USDT" : "USD"})</span>
            <input className="input num" type="number" value={balance} onChange={(e) => setBalance(Number(e.target.value))} />
          </label>
          <label>
            <span className="label">Default risk %</span>
            <input className="input num" type="number" step={0.1} value={risk} onChange={(e) => setRisk(Number(e.target.value))} />
          </label>
          <label>
            <span className="label">Leverage (1 = fully funded)</span>
            <input className="input num" type="number" min={1} step={1} value={shownLeverage} onChange={(e) => setLeverage(Math.max(1, Number(e.target.value)))} />
          </label>
          <label>
            <span className="label">Name (optional)</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>

        <details className="mt-3 rounded-md border border-line p-2">
          <summary className="cursor-pointer text-muted">Costs & execution — {assetClass} defaults</summary>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {COST_FIELDS.map(([k, label, step]) => (
              <label key={k}>
                <span className="label">{label}</span>
                <input
                  className="input num"
                  type="number"
                  step={step}
                  value={shownCosts[k] ?? 0}
                  onChange={(e) => {
                    setCosts({ ...shownCosts, [k]: Number(e.target.value) });
                    setCostsTouched(true);
                  }}
                />
              </label>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-faint">
            Commission is in account currency per quantity unit (per lot for FX/metals, per share for stocks). When the data has a real bid/ask spread (Dukascopy, OANDA), it replaces the spread setting.
          </p>
          {providerId === "binance" && (
            <label className="mt-2 flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={resolveLowerTf} onChange={(e) => setResolve(e.target.checked)} />
              Resolve same-candle SL/TP with 1m data (otherwise SL is assumed first)
            </label>
          )}
        </details>

        <p className={`mt-3 text-[12px] ${tooMany ? "text-down" : "text-muted"}`}>
          ≈ {bars.toLocaleString()} bars
          {tooMany ? ` — over the ${MAX_BARS.toLocaleString()} limit; shorten the range or use a higher timeframe.` : ". Downloaded once, cached locally, and only missing ranges are fetched next time."}
        </p>
        {slowMinute && <p className="mt-1 text-[12px] text-warn">Dukascopy minute data needs 2 requests per day and is rate-limited — long ranges can take many minutes. 1h or higher is much faster.</p>}
        {job && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded bg-raised">
              <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
            <p className="mt-1 text-[12px] text-muted">Downloading market data… {Math.round(job.progress * 100)}%</p>
          </div>
        )}
        {error && <p className="mt-2 text-[12px] text-down">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || tooMany || bars < 2 || (source === "csv" ? !datasetId : Boolean(unavailable))} onClick={create}>
            {busy ? (job ? "Downloading…" : "Creating…") : "Create session"}
          </button>
        </div>
      </div>
    </div>
  );
}
