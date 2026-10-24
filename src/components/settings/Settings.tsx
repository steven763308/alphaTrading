"use client";

import { useEffect, useState } from "react";
import { Toasts } from "@/components/Toasts";
import { TIMEFRAMES } from "@/lib/market/timeframes";
import { api } from "@/lib/client/api";
import { fmtMoney, fmtTime } from "@/lib/client/format";
import { useSettings, useStrategies, useToasts } from "@/lib/client/hooks";
import type { AppSettings, LiveState } from "@/lib/client/types";

const COSTS = [
  ["makerFeeBps", "Maker (bps)"],
  ["takerFeeBps", "Taker (bps)"],
  ["spreadBps", "Spread (bps)"],
  ["slippageBps", "Slippage (bps)"],
  ["commissionPerUnit", "Comm./unit/side"],
] as const;

const CLASS_LABEL: Record<string, string> = {
  crypto: "Crypto",
  forex: "Forex (per lot)",
  metals: "Metals (per lot)",
  stocks: "Stocks (per share)",
  indices: "Indices",
  futures: "Futures",
  commodities: "Commodities",
  custom: "Custom",
};

export function Settings() {
  const { settings, setSettings } = useSettings();
  const { toasts, push, dismiss } = useToasts();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-3 p-3 md:gap-4 md:p-4 lg:grid-cols-2">
        {settings && (
          <General settings={settings} onSaved={setSettings} push={push} />
        )}
        <DeviceAccess />
        <Providers push={push} />
        <Strategies push={push} />
        <CsvImport push={push} />
        <LiveAccount push={push} />
        <section className="panel p-4 lg:col-span-2">
          <h2 className="mb-2 font-semibold">Limitations</h2>
          <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted">
            <li>
              All prices are real provider data; missing bars are reported as
              gaps and never generated. No delayed or substitute data is used
              without disclosure.
            </li>
            <li>
              Live paper orders are only monitored while this app runs;
              automatic execution while your computer is off needs an always-on
              service. After downtime, missed periods are reconciled from 1m
              candles and resulting fills are flagged &ldquo;approx&rdquo;.
            </li>
            <li>
              Leverage, financing and costs are simulation assumptions, not any
              broker&apos;s terms. Same-candle SL/TP ambiguity assumes the stop
              first unless 1m data resolves it.
            </li>
            <li>
              USDT is treated as USD 1:1. Cross-currency P&amp;L is converted
              with the conversion pair&apos;s close (historical) or live price.
            </li>
          </ul>
        </section>
      </div>
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

type Push = (k: "error" | "warn" | "info", t: string) => void;

function General({
  settings,
  onSaved,
  push,
}: {
  settings: AppSettings;
  onSaved: (s: AppSettings) => void;
  push: Push;
}) {
  const [s, setS] = useState(settings);
  const [saving, setSaving] = useState(false);
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC"];
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ settings: AppSettings }>("/api/settings", {
        method: "PUT",
        json: s,
      });
      onSaved(r.settings);
      push(
        "info",
        "Settings saved. New sessions use these defaults; existing sessions keep their own cost snapshot.",
      );
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
          <select
            className="input"
            value={s.timeZone}
            onChange={(e) => setS({ ...s, timeZone: e.target.value })}
          >
            {["UTC", ...zones.filter((z) => z !== "UTC")].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Default risk % per trade</span>
          <input
            className="input num"
            type="number"
            step={0.1}
            value={s.riskPercent}
            onChange={(e) =>
              setS({ ...s, riskPercent: Number(e.target.value) })
            }
          />
        </label>
        <label>
          <span className="label">Default symbol</span>
          <input
            className="input num uppercase"
            value={s.defaultSymbol}
            onChange={(e) =>
              setS({ ...s, defaultSymbol: e.target.value.toUpperCase() })
            }
          />
        </label>
        <label>
          <span className="label">Default timeframe</span>
          <select
            className="input"
            value={s.defaultTimeframe}
            onChange={(e) => setS({ ...s, defaultTimeframe: e.target.value })}
          >
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Live data stale after (s)</span>
          <input
            className="input num"
            type="number"
            value={s.staleAfterSeconds}
            onChange={(e) =>
              setS({ ...s, staleAfterSeconds: Number(e.target.value) })
            }
          />
        </label>
        <label>
          <span className="label">Reconcile lookback (hours)</span>
          <input
            className="input num"
            type="number"
            value={s.reconcileLookbackHours}
            onChange={(e) =>
              setS({ ...s, reconcileLookbackHours: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <div>
        <span className="label">
          Default costs by market (new sessions; crypto also applies to the live
          account)
        </span>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="data-table text-[12px]">
            <thead>
              <tr>
                <th>Market</th>
                {COSTS.map(([, label]) => (
                  <th key={label} className="r">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(s.costsByAssetClass).map(([cls, c]) => (
                <tr key={cls}>
                  <td>{CLASS_LABEL[cls] ?? cls}</td>
                  {COSTS.map(([k]) => (
                    <td key={k} className="r">
                      <input
                        className="input num w-[72px] text-right"
                        type="number"
                        step={0.1}
                        value={c[k] ?? 0}
                        onChange={(e) => {
                          const next = { ...c, [k]: Number(e.target.value) };
                          setS({
                            ...s,
                            costsByAssetClass: {
                              ...s.costsByAssetClass,
                              [cls]: next,
                            },
                            ...(cls === "crypto" ? { costs: next } : {}),
                          });
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <button className="btn btn-primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save settings"}
      </button>
    </section>
  );
}

interface ProviderInfo {
  id: string;
  name: string;
  assetClasses: string[];
  historical: boolean;
  live: boolean;
  configured: boolean;
  requiresCredentials: boolean;
  verification: string;
  rateLimit: string;
  licensing: string;
  delay: string;
  notes: string[];
  bidAsk: { historical: boolean; live: boolean };
}

function Providers({ push }: { push: Push }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [checking, setChecking] = useState<string | null>(null);
  useEffect(() => {
    api<{ providers: ProviderInfo[] }>("/api/system")
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  }, []);
  const check = async (id: string) => {
    setChecking(id);
    try {
      const r = await api<{
        ok: boolean;
        message: string;
        latencyMs: number | null;
      }>(`/api/providers/${id}/check`, { method: "POST" });
      push(
        r.ok ? "info" : "warn",
        `${id}: ${r.message}${r.latencyMs != null ? ` (${r.latencyMs} ms)` : ""}`,
      );
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(null);
    }
  };
  return (
    <section className="panel space-y-3 p-4 lg:col-span-2">
      <h2 className="font-semibold">Data providers</h2>
      <p className="text-[12px] text-muted">
        Each adapter is verified independently.{" "}
        <b className="text-ink">Unverified</b> adapters were built from the
        provider&apos;s documentation and need your credentials to be exercised
        — treat them as not production-ready until the test passes.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {providers.map((p) => (
          <div
            key={p.id}
            className="rounded-md border border-line p-3 text-[12px]"
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{p.name}</span>
              <span
                className={`rounded px-1.5 ${p.configured ? "bg-up/15 text-up" : "bg-raised text-muted"}`}
              >
                {p.configured ? "configured" : "needs credentials"}
              </span>
              <span
                className={`rounded px-1.5 ${p.verification === "verified" ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn"}`}
              >
                {p.verification}
              </span>
              {p.id !== "csv" && (
                <button
                  className="btn btn-ghost ml-auto py-0.5 text-[12px]"
                  disabled={checking === p.id}
                  onClick={() => check(p.id)}
                >
                  {checking === p.id ? "Testing…" : "Test"}
                </button>
              )}
            </div>
            <div className="text-muted">
              {p.assetClasses.join(", ")} ·{" "}
              {[p.historical && "historical", p.live && "live"]
                .filter(Boolean)
                .join(" + ")}{" "}
              · {p.delay}
              {p.bidAsk.historical || p.bidAsk.live ? " · bid/ask" : ""}
            </div>
            <div className="mt-1 text-faint">{p.rateLimit}</div>
            <ul className="mt-1 list-disc pl-4 text-muted">
              {p.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>{p.licensing}</li>
            </ul>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-faint">
        Credentials go in <code>.env.local</code>: <code>OANDA_API_TOKEN</code>,{" "}
        <code>OANDA_ACCOUNT_ID</code> (free practice account) ·{" "}
        <code>ALPACA_KEY_ID</code>, <code>ALPACA_SECRET_KEY</code> (free, IEX
        feed). Restart the app after editing.
      </p>
    </section>
  );
}

function DeviceAccess() {
  const [info, setInfo] = useState<{
    lanUrls: string[];
    accessKeyEnabled: boolean;
    devMode: boolean;
  } | null>(null);
  useEffect(() => {
    api<{ lanUrls: string[]; accessKeyEnabled: boolean; devMode: boolean }>(
      "/api/system",
    )
      .then(setInfo)
      .catch(() => {});
  }, []);
  return (
    <section className="panel space-y-2 p-4 text-[12px]">
      <h2 className="text-[13px] font-semibold">
        Use on iPad / iPhone / Android
      </h2>
      <p className="text-muted">
        With your phone or tablet on the same Wi-Fi, open:
      </p>
      {info?.lanUrls.length ? (
        <ul className="space-y-1">
          {info.lanUrls.map((u) => (
            <li
              key={u}
              className="num select-all rounded bg-bg px-2 py-1 text-[13px] text-ink"
            >
              {u}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-warn">No private network address found.</p>
      )}
      <ul className="list-disc space-y-1 pl-4 text-muted">
        <li>
          Safari: Share → <b className="text-ink">Add to Home Screen</b> to open
          it full-screen like an app.
        </li>
        <li>
          Allow Node.js through Windows Firewall on{" "}
          <b className="text-ink">private</b> networks when Windows asks.
        </li>
        <li>
          Access key:{" "}
          {info?.accessKeyEnabled ? (
            <span className="text-up">enabled</span>
          ) : (
            <span className="text-warn">
              off — anyone on your Wi-Fi can open it. Set TRADELAB_ACCESS_KEY in
              .env.local.
            </span>
          )}
        </li>
        {info?.devMode && (
          <li>
            Running the dev server — for devices prefer{" "}
            <code>npm run build</code> then <code>npm run start:lan</code>{" "}
            (faster).
          </li>
        )}
        <li>
          Away from home needs a private tunnel/VPN (e.g. Tailscale); TradeLab
          never exposes itself to the internet.
        </li>
      </ul>
    </section>
  );
}

function Strategies({ push }: { push: Push }) {
  const { strategies, reload } = useStrategies();
  const [name, setName] = useState("");
  const add = async () => {
    try {
      await api("/api/strategies", {
        method: "POST",
        json: { name, color: "#3987e5" },
      });
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
      <p className="text-[12px] text-muted">
        Tag orders and sessions with a strategy to compare performance in
        Analytics. Archived strategies stay in historical data.
      </p>
      <ul className="divide-y divide-line">
        {strategies.map((s) => (
          <li key={s.id} className="flex items-center gap-2 py-1.5">
            <input
              type="color"
              className="h-5 w-6 cursor-pointer bg-transparent"
              value={s.color ?? "#3987e5"}
              onChange={(e) => patch(s.id, { color: e.target.value })}
            />
            <input
              className={`input flex-1 ${s.archived ? "text-faint line-through" : ""}`}
              defaultValue={s.name}
              onBlur={(e) =>
                e.target.value.trim() &&
                e.target.value !== s.name &&
                patch(s.id, { name: e.target.value })
              }
            />
            <button
              className="btn btn-ghost text-[12px]"
              onClick={() => patch(s.id, { archived: !s.archived })}
            >
              {s.archived ? "Restore" : "Archive"}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="New strategy name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && add()}
        />
        <button className="btn" disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

interface DatasetRow {
  dataset: {
    id: number;
    sourceId: string;
    timeframe: string;
    label: string;
    candleCount: number;
    firstTime: number | null;
    lastTime: number | null;
    version: number;
  };
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
  const load = () =>
    api<DatasetRow[]>("/api/datasets")
      .then(setDatasets)
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const r = await api<{
        inserted: number;
        duplicates: number;
        gaps: number;
        errors: string[];
      }>("/api/datasets", {
        method: "POST",
        json: {
          symbol,
          timeframe,
          text,
          label:
            file.name.replace(/\.[^.]+$/, "").slice(0, 60) +
            "-" +
            Date.now().toString(36),
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
        Columns: <code>time, open, high, low, close[, volume]</code> (ISO or
        epoch; UTC assumed), or headerless Binance kline dumps. Each import
        becomes an immutable dataset.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label>
          <span className="label">Symbol</span>
          <input
            className="input num uppercase"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="EURUSD"
          />
        </label>
        <label>
          <span className="label">Timeframe</span>
          <select
            className="input"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
          >
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Tick size (optional)</span>
          <input
            className="input num"
            value={tickSize}
            onChange={(e) => setTickSize(e.target.value)}
            placeholder="inferred"
          />
        </label>
        <label>
          <span className="label">Quantity step (optional)</span>
          <input
            className="input num"
            value={qtyStep}
            onChange={(e) => setQtyStep(e.target.value)}
            placeholder="0.0001"
          />
        </label>
      </div>
      <input
        type="file"
        accept=".csv,.txt"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-[12px] text-muted file:mr-3 file:rounded file:border-0 file:bg-raised file:px-3 file:py-1 file:text-ink"
      />
      <button
        className="btn btn-primary"
        disabled={!file || symbol.length < 2 || busy}
        onClick={run}
      >
        {busy ? "Importing…" : "Import"}
      </button>
      {datasets.length > 0 && (
        <div className="overflow-x-auto">
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
                  <td className="r num">
                    {d.dataset.candleCount.toLocaleString()}
                  </td>
                  <td className="num text-muted">
                    {fmtTime(d.dataset.firstTime).slice(0, 10)} →{" "}
                    {fmtTime(d.dataset.lastTime).slice(0, 10)}
                  </td>
                  <td className="r num text-muted">{d.dataset.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
    if (
      !confirm(
        "Reset the live paper balance? Past trades remain in the journal.",
      )
    )
      return;
    try {
      const { settings } = await api<{ settings: AppSettings }>(
        "/api/settings",
      );
      await api("/api/live/reset", {
        method: "POST",
        json: { startingBalance: balance, costs: settings.costs },
      });
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
          <dd className="num text-right">
            {fmtMoney(state.account.balance)} USDT
          </dd>
          <dt className="text-muted">Started with</dt>
          <dd className="num text-right">
            {fmtMoney(state.account.startingBalance)} USDT
          </dd>
          <dt className="text-muted">Open positions / pending orders</dt>
          <dd className="num text-right">
            {state.openPositions.length} / {state.pendingOrders.length}
          </dd>
        </dl>
      )}
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="label">New starting balance (USDT)</span>
          <input
            className="input num"
            type="number"
            value={balance}
            onChange={(e) => setBalance(Number(e.target.value))}
          />
        </label>
        <button className="btn" onClick={reset}>
          Reset balance
        </button>
      </div>
      <p className="text-[11px] text-faint">
        Live account costs use the values saved in General at the time of the
        reset.
      </p>
    </section>
  );
}
