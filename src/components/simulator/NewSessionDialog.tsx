"use client";

import { useEffect, useState } from "react";
import { TIMEFRAMES, timeframeMs } from "@/lib/market/timeframes";
import { api } from "@/lib/client/api";
import type { AppSettings, SessionView, Strategy } from "@/lib/client/types";

interface Dataset {
  dataset: { id: number; timeframe: string; label: string; sourceId: string; firstTime: number | null; lastTime: number | null; candleCount: number };
  symbol: string;
}

const MAX_BARS = 250_000;
const COST_LABELS = { makerFeeBps: "Maker fee", takerFeeBps: "Taker fee", spreadBps: "Spread", slippageBps: "Slippage" };
const day = (d: Date) => d.toISOString().slice(0, 10);

export function NewSessionDialog({
  settings,
  strategies,
  onCreated,
  onClose,
}: {
  settings: AppSettings;
  strategies: Strategy[];
  onCreated: (v: SessionView) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"binance" | "csv">("binance");
  const [symbol, setSymbol] = useState(settings.defaultSymbol);
  const [timeframe, setTimeframe] = useState(settings.defaultTimeframe === "1m" ? "15m" : settings.defaultTimeframe);
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 60 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date(Date.now() - 30 * 86_400_000)));
  const [today] = useState(() => day(new Date()));
  const [balance, setBalance] = useState(10_000);
  const [risk, setRisk] = useState(settings.riskPercent);
  const [strategyId, setStrategyId] = useState<number | null>(null);
  const [costs, setCosts] = useState(settings.costs);
  const [resolveLowerTf, setResolve] = useState(true);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Dataset[]>("/api/datasets")
      .then((d) => setDatasets(d.filter((x) => x.dataset.sourceId === "csv")))
      .catch(() => {});
  }, []);

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

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const v = await api<SessionView>("/api/sessions", {
        method: "POST",
        json: {
          name: name || undefined,
          source,
          symbol: source === "binance" ? symbol : undefined,
          datasetId: source === "csv" ? datasetId : undefined,
          timeframe,
          from: fromMs,
          to: Math.min(toMs, Date.now()),
          startingBalance: balance,
          riskPercent: risk,
          strategyId,
          costs,
          resolveLowerTf,
        },
      });
      onCreated(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="panel w-full max-w-lg p-5" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-base font-semibold">New backtest session</h2>
        <p className="mb-4 text-[12px] text-muted">Replays real historical candles bar by bar. Future candles stay hidden until you step forward.</p>

        <div className="mb-3 flex gap-1 rounded-md bg-bg p-0.5">
          {(["binance", "csv"] as const).map((s) => (
            <button key={s} onClick={() => setSource(s)} className={`flex-1 rounded py-1.5 ${source === s ? "bg-raised text-ink" : "text-muted"}`}>
              {s === "binance" ? "Binance public data" : "Imported CSV"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          {source === "binance" ? (
            <label>
              <span className="label">Symbol</span>
              <input className="input num uppercase" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
            </label>
          ) : (
            <label>
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
              {TIMEFRAMES.map((t) => (
                <option key={t}>{t}</option>
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
            <span className="label">Starting balance (USDT)</span>
            <input className="input num" type="number" value={balance} onChange={(e) => setBalance(Number(e.target.value))} />
          </label>
          <label>
            <span className="label">Default risk %</span>
            <input className="input num" type="number" step={0.1} value={risk} onChange={(e) => setRisk(Number(e.target.value))} />
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
            <span className="label">Name (optional)</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>

        <details className="mt-3 rounded-md border border-line p-2">
          <summary className="cursor-pointer text-muted">Costs & execution (bps)</summary>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {(["makerFeeBps", "takerFeeBps", "spreadBps", "slippageBps"] as const).map((k) => (
              <label key={k}>
                <span className="label">{COST_LABELS[k]}</span>
                <input className="input num" type="number" step={0.5} value={costs[k]} onChange={(e) => setCosts({ ...costs, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={resolveLowerTf} onChange={(e) => setResolve(e.target.checked)} />
            Resolve same-candle SL/TP with 1m data (Binance only; otherwise SL is assumed first)
          </label>
        </details>

        <p className={`mt-3 text-[12px] ${tooMany ? "text-down" : "text-muted"}`}>
          ≈ {bars.toLocaleString()} bars{tooMany ? ` — over the ${MAX_BARS.toLocaleString()} limit; shorten the range or use a higher timeframe.` : ". Data is downloaded once and cached locally."}
        </p>
        {error && <p className="mt-2 text-[12px] text-down">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || tooMany || bars < 2 || (source === "csv" && !datasetId)} onClick={create}>
            {busy ? "Downloading data…" : "Create session"}
          </button>
        </div>
      </div>
    </div>
  );
}
