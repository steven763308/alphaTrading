"use client";

import { useEffect, useState } from "react";
import { Toasts } from "@/components/Toasts";
import { TIMEFRAMES } from "@/lib/market/timeframes";
import { api } from "@/lib/client/api";
import { fmtMoney, fmtTime } from "@/lib/client/format";
import { useSettings, useStrategies, useToasts } from "@/lib/client/hooks";
import type { AppSettings, LiveState } from "@/lib/client/types";

const COSTS = [
  ["makerFeeBps", "Maker fee (bps)"],
  ["takerFeeBps", "Taker fee (bps)"],
  ["spreadBps", "Spread (bps)"],
  ["slippageBps", "Slippage (bps)"],
] as const;

export function Settings() {
  const { settings, endpoints, setSettings } = useSettings();
  const { toasts, push, dismiss } = useToasts();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-4 p-4 lg:grid-cols-2">
        {settings && <General settings={settings} onSaved={setSettings} push={push} />}
        <Strategies push={push} />
        <CsvImport push={push} />
        <LiveAccount push={push} />
        <section className="panel p-4 lg:col-span-2">
          <h2 className="mb-2 font-semibold">Data sources & limitations</h2>
          <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted">
            <li>
              Market data: Binance public REST <code className="text-ink">{endpoints?.rest}</code> and WebSocket <code className="text-ink">{endpoints?.ws}</code> (no API key, no
              orders). Override with <code>BINANCE_REST_URL</code> / <code>BINANCE_WS_URL</code>.
            </li>
            <li>All prices are real exchange candles; missing bars are reported as gaps and never generated.</li>
            <li>Live paper orders are only monitored while this app runs. After downtime, missed periods are reconciled from 1m candles and resulting fills are flagged “approx”.</li>
            <li>Candle prices are treated as mid prices; spread, slippage and fees are modelled with the parameters above. Same-candle SL/TP ambiguity assumes the stop first unless 1m data resolves it.</li>
          </ul>
        </section>
      </div>
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

type Push = (k: "error" | "warn" | "info", t: string) => void;

function General({ settings, onSaved, push }: { settings: AppSettings; onSaved: (s: AppSettings) => void; push: Push }) {
  const [s, setS] = useState(settings);
  const [saving, setSaving] = useState(false);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ settings: AppSettings }>("/api/settings", { method: "PUT", json: s });
      onSaved(r.settings);
      push("info", "Settings saved. New sessions use these defaults; existing sessions keep their own cost snapshot.");
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="font-semibold">General</h2>
      <div className="grid grid-cols-2 gap-3">
        <label>
          <span className="label">Display time zone</span>
          <select className="input" value={s.timeZone} onChange={(e) => setS({ ...s, timeZone: e.target.value })}>
            {["UTC", ...zones.filter((z) => z !== "UTC")].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Default risk % per trade</span>
          <input className="input num" type="number" step={0.1} value={s.riskPercent} onChange={(e) => setS({ ...s, riskPercent: Number(e.target.value) })} />
        </label>
        <label>
          <span className="label">Default symbol</span>
          <input className="input num uppercase" value={s.defaultSymbol} onChange={(e) => setS({ ...s, defaultSymbol: e.target.value.toUpperCase() })} />
        </label>
        <label>
          <span className="label">Default timeframe</span>
          <select className="input" value={s.defaultTimeframe} onChange={(e) => setS({ ...s, defaultTimeframe: e.target.value })}>
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        {COSTS.map(([k, label]) => (
          <label key={k}>
            <span className="label">{label}</span>
            <input className="input num" type="number" step={0.5} value={s.costs[k]} onChange={(e) => setS({ ...s, costs: { ...s.costs, [k]: Number(e.target.value) } })} />
          </label>
        ))}
        <label>
          <span className="label">Live data stale after (s)</span>
          <input className="input num" type="number" value={s.staleAfterSeconds} onChange={(e) => setS({ ...s, staleAfterSeconds: Number(e.target.value) })} />
        </label>
        <label>
          <span className="label">Reconcile lookback (hours)</span>
          <input className="input num" type="number" value={s.reconcileLookbackHours} onChange={(e) => setS({ ...s, reconcileLookbackHours: Number(e.target.value) })} />
        </label>
      </div>
      <button className="btn btn-primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save settings"}
      </button>
    </section>
  );
}

function Strategies({ push }: { push: Push }) {
  const { strategies, reload } = useStrategies();
  const [name, setName] = useState("");
  const add = async () => {
    try {
      await api("/api/strategies", { method: "POST", json: { name, color: "#3987e5" } });
      setName("");
      reload();
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    }
  };
  const patch = async (id: number, body: Record<string, unknown>) => {
    try {
      await api(`/api/strategies/${id}`, { method: "PATCH", json: body });
      reload();
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="font-semibold">Strategies</h2>
      <p className="text-[12px] text-muted">Tag orders and sessions with a strategy to compare performance in Analytics. Archived strategies stay in historical data.</p>
      <ul className="divide-y divide-line">
        {strategies.map((s) => (
          <li key={s.id} className="flex items-center gap-2 py-1.5">
            <input type="color" className="h-5 w-6 cursor-pointer bg-transparent" value={s.color ?? "#3987e5"} onChange={(e) => patch(s.id, { color: e.target.value })} />
            <input
              className={`input flex-1 ${s.archived ? "text-faint line-through" : ""}`}
              defaultValue={s.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && patch(s.id, { name: e.target.value })}
            />
            <button className="btn btn-ghost text-[12px]" onClick={() => patch(s.id, { archived: !s.archived })}>
              {s.archived ? "Restore" : "Archive"}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input className="input" placeholder="New strategy name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && add()} />
        <button className="btn" disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

interface DatasetRow {
  dataset: { id: number; sourceId: string; timeframe: string; label: string; candleCount: number; firstTime: number | null; lastTime: number | null; version: number };
  symbol: string;
}

function CsvImport({ push }: { push: Push }) {
  const [symbol, setSymbol] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [tickSize, setTickSize] = useState("");
  const [qtyStep, setQtyStep] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const load = () => api<DatasetRow[]>("/api/datasets").then(setDatasets).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const r = await api<{ inserted: number; duplicates: number; gaps: number; errors: string[] }>("/api/datasets", {
        method: "POST",
        json: {
          symbol,
          timeframe,
          text,
          label: file.name.replace(/\.[^.]+$/, "").slice(0, 60) + "-" + Date.now().toString(36),
          tickSize: tickSize ? Number(tickSize) : undefined,
          qtyStep: qtyStep ? Number(qtyStep) : undefined,
        },
      });
      push(
        r.errors.length || r.gaps ? "warn" : "info",
        `Imported ${r.inserted} candles (${r.duplicates} duplicates dropped, ${r.gaps} missing bars${r.errors.length ? `, ${r.errors.length}+ invalid rows skipped` : ""}).`,
      );
      setFile(null);
      load();
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel space-y-3 p-4">
      <h2 className="font-semibold">Import historical CSV</h2>
      <p className="text-[12px] text-muted">
        Columns: <code>time, open, high, low, close[, volume]</code> (ISO or epoch; UTC assumed), or headerless Binance kline dumps. Each import becomes an immutable dataset.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label>
          <span className="label">Symbol</span>
          <input className="input num uppercase" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="EURUSD" />
        </label>
        <label>
          <span className="label">Timeframe</span>
          <select className="input" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Tick size (optional)</span>
          <input className="input num" value={tickSize} onChange={(e) => setTickSize(e.target.value)} placeholder="inferred" />
        </label>
        <label>
          <span className="label">Quantity step (optional)</span>
          <input className="input num" value={qtyStep} onChange={(e) => setQtyStep(e.target.value)} placeholder="0.0001" />
        </label>
      </div>
      <input type="file" accept=".csv,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[12px] text-muted file:mr-3 file:rounded file:border-0 file:bg-raised file:px-3 file:py-1 file:text-ink" />
      <button className="btn btn-primary" disabled={!file || symbol.length < 2 || busy} onClick={run}>
        {busy ? "Importing…" : "Import"}
      </button>
      {datasets.length > 0 && (
        <table className="data-table text-[12px]">
          <thead>
            <tr>
              <th>Source</th>
              <th>Symbol</th>
              <th>TF</th>
              <th className="r">Candles</th>
              <th>Range (UTC)</th>
              <th className="r">v</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.dataset.id} title={d.dataset.label}>
                <td className="text-muted">{d.dataset.sourceId}</td>
                <td>{d.symbol}</td>
                <td>{d.dataset.timeframe}</td>
                <td className="r num">{d.dataset.candleCount.toLocaleString()}</td>
                <td className="num text-muted">
                  {fmtTime(d.dataset.firstTime).slice(0, 10)} → {fmtTime(d.dataset.lastTime).slice(0, 10)}
                </td>
                <td className="r num text-muted">{d.dataset.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LiveAccount({ push }: { push: Push }) {
  const [state, setState] = useState<LiveState | null>(null);
  const [balance, setBalance] = useState(10_000);
  const load = () =>
    api<LiveState>("/api/live/state")
      .then((s) => {
        setState(s);
        setBalance(s.account.startingBalance);
      })
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);
  const reset = async () => {
    if (!confirm("Reset the live paper balance? Past trades remain in the journal.")) return;
    try {
      const { settings } = await api<{ settings: AppSettings }>("/api/settings");
      await api("/api/live/reset", { method: "POST", json: { startingBalance: balance, costs: settings.costs } });
      push("info", "Live paper account reset.");
      load();
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="font-semibold">Live paper account</h2>
      {state && (
        <dl className="grid grid-cols-2 gap-1 text-[12px]">
          <dt className="text-muted">Balance</dt>
          <dd className="num text-right">{fmtMoney(state.account.balance)} USDT</dd>
          <dt className="text-muted">Started with</dt>
          <dd className="num text-right">{fmtMoney(state.account.startingBalance)} USDT</dd>
          <dt className="text-muted">Open positions / pending orders</dt>
          <dd className="num text-right">
            {state.openPositions.length} / {state.pendingOrders.length}
          </dd>
        </dl>
      )}
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="label">New starting balance (USDT)</span>
          <input className="input num" type="number" value={balance} onChange={(e) => setBalance(Number(e.target.value))} />
        </label>
        <button className="btn" onClick={reset}>
          Reset balance
        </button>
      </div>
      <p className="text-[11px] text-faint">Live account costs use the values saved in General at the time of the reset.</p>
    </section>
  );
}
