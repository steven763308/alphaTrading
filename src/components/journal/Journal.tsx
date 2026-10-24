"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandleChart, type CandleChartHandle, type ChartMarker } from "@/components/CandleChart";
import { Filters, emptyFilters, filterQuery, type FilterState } from "@/components/Filters";
import { FlagBadges } from "@/components/simulator/TradesPanel";
import { Toasts } from "@/components/Toasts";
import type { Bar } from "@/lib/engine/types";
import { barStart } from "@/lib/market/timeframes";
import { api, qs } from "@/lib/client/api";
import { FLAG_LABELS, fmtDuration, fmtMoney, fmtPrice, fmtQty, fmtR, fmtTime, pnlClass } from "@/lib/client/format";
import { usePersistentState, useSettings, useStrategies, useToasts } from "@/lib/client/hooks";
import type { JournalRow } from "@/lib/client/types";

const PAGE = 100;

interface ExecutionRow {
  id: string;
  kind: string;
  side: string;
  qty: number;
  price: number;
  referencePrice: number;
  fee: number;
  spreadCost: number;
  slippageCost: number;
  liquidity: string;
  reason: string;
  time: number;
  flags: string[];
  recordedAt: number;
}

export function Journal() {
  const { settings } = useSettings();
  const { strategies } = useStrategies();
  const { toasts, push, dismiss } = useToasts();
  const [filters, setFilters] = usePersistentState<FilterState>("tl.journal.filters", emptyFilters);
  const [rows, setRows] = useState<JournalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [markets, setMarkets] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const tz = settings?.timeZone ?? "UTC";

  useEffect(() => {
    api<{ rows: JournalRow[]; total: number; facets: { symbols: string[]; markets: string[] } }>(`/api/journal${qs({ ...filterQuery(filters), limit: PAGE, offset })}`)
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
        setSymbols(r.facets.symbols);
        setMarkets(r.facets.markets);
      })
      .catch((e) => push("error", e.message));
  }, [filters, offset, push]);

  const changeFilters = (f: FilterState) => {
    setFilters(f);
    setOffset(0);
  };

  const pageNet = rows.reduce((s, r) => s + r.netPnl, 0);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-start gap-2 border-b border-line p-2 md:items-end md:gap-4 md:p-3">
          <Filters value={{ ...emptyFilters, ...filters }} onChange={changeFilters} strategies={strategies} symbols={symbols} markets={markets} />
          <a className="btn ml-auto" href={`/api/journal/export${qs(filterQuery(filters))}`}>
            Export CSV
          </a>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="p-8 text-center text-muted">No trades yet. Closed simulator trades are journaled automatically.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Exit time</th>
                  <th>Mode</th>
                  <th>Market</th>
                  <th>Symbol</th>
                  <th>TF</th>
                  <th>Strategy</th>
                  <th>Side</th>
                  <th className="r">Entry</th>
                  <th className="r">Exit</th>
                  <th className="r">Qty</th>
                  <th>Exit reason</th>
                  <th className="r">Net P&L</th>
                  <th className="r">R</th>
                  <th className="r">Held</th>
                  <th className="r">Setup</th>
                  <th>Rules</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`clickable ${selected === r.id ? "[&>td]:bg-hover" : ""}`} onClick={() => setSelected(r.id)}>
                    <td className="num text-muted">{fmtTime(r.exitTime, tz)}</td>
                    <td className="text-muted">{r.mode === "live" ? "Live" : "Hist"}</td>
                    <td className="text-muted">{r.market}</td>
                    <td>{r.symbol}</td>
                    <td className="text-muted">{r.timeframe}</td>
                    <td>{r.strategyName ?? <span className="text-faint">—</span>}</td>
                    <td className={r.direction === "long" ? "text-up" : "text-down"}>{r.direction}</td>
                    <td className="r num">{fmtPrice(r.entryPrice)}</td>
                    <td className="r num">{fmtPrice(r.exitPrice)}</td>
                    <td className="r num">{fmtQty(r.qty, 0.00001)}</td>
                    <td>
                      {r.exitReason.replace("_", " ")}
                      <FlagBadges flags={r.flags} />
                    </td>
                    <td className={`r num ${pnlClass(r.netPnl)}`}>{fmtMoney(r.netPnl, { sign: true })}</td>
                    <td className={`r num ${pnlClass(r.rMultiple)}`}>{fmtR(r.rMultiple)}</td>
                    <td className="r num text-muted">{fmtDuration(r.holdingMs)}</td>
                    <td className="r">{r.setupQuality ? "★".repeat(r.setupQuality) : <span className="text-faint">—</span>}</td>
                    <td>{r.ruleFollowed == null ? <span className="text-faint">—</span> : r.ruleFollowed ? "✓" : <span className="text-down">✗</span>}</td>
                    <td className="max-w-[220px] truncate text-muted">{r.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex h-10 shrink-0 items-center gap-3 border-t border-line px-3 text-[12px] text-muted">
          <span>
            {total} trade{total === 1 ? "" : "s"} · page net <span className={`num ${pnlClass(pageNet)}`}>{fmtMoney(pageNet, { sign: true })}</span>
          </span>
          <div className="ml-auto flex gap-2">
            <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ‹ Prev
            </button>
            <button className="btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              Next ›
            </button>
          </div>
        </div>
      </div>
      {selected != null && (
        <TradeDrawer
          key={selected}
          id={selected}
          timeZone={tz}
          onClose={() => setSelected(null)}
          onSaved={(row) => {
            setRows((rs) => rs.map((r) => (r.id === row.id ? row : r)));
            push("info", "Journal notes saved. Execution records are unchanged.");
          }}
          onError={(m) => push("error", m)}
        />
      )}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function TradeDrawer({ id, timeZone, onClose, onSaved, onError }: { id: number; timeZone: string; onClose: () => void; onSaved: (r: JournalRow) => void; onError: (m: string) => void }) {
  const [entry, setEntry] = useState<(JournalRow & { executions: ExecutionRow[] }) | null>(null);
  const [notes, setNotes] = useState("");
  const [quality, setQuality] = useState<number | null>(null);
  const [rule, setRule] = useState<boolean | null>(null);
  const [tags, setTags] = useState("");
  const [annotations, setAnnotations] = useState<{ time: number; price: number; text: string }[]>([]);
  const [annotating, setAnnotating] = useState(false);
  const [saving, setSaving] = useState(false);
  const chartRef = useRef<CandleChartHandle>(null);

  useEffect(() => {
    api<JournalRow & { executions: ExecutionRow[] }>(`/api/journal/${id}`)
      .then((e) => {
        setEntry(e);
        setNotes(e.notes ?? "");
        setQuality(e.setupQuality);
        setRule(e.ruleFollowed);
        setTags((e.tags ?? []).join(", "));
        setAnnotations(e.annotations ?? []);
      })
      .catch((e) => onError(e.message));
    api<Bar[]>(`/api/journal/${id}/candles`)
      .then((bars) => chartRef.current?.setData(bars))
      .catch(() => {});
  }, [id, onError]);

  const markers = useMemo<ChartMarker[]>(() => {
    if (!entry) return [];
    const long = entry.direction === "long";
    const snap = (t: number) => barStart(t, entry.timeframe);
    return [
      { time: snap(entry.entryTime), position: long ? "belowBar" : "aboveBar", color: long ? "#26a69a" : "#ef5350", shape: long ? "arrowUp" : "arrowDown", text: "Entry" },
      { time: snap(entry.exitTime), position: long ? "aboveBar" : "belowBar", color: entry.netPnl >= 0 ? "#26a69a" : "#ef5350", shape: "circle", text: "Exit" },
      ...annotations.map((a, i) => ({ time: snap(a.time), position: "aboveBar" as const, color: "#fab219", shape: "square" as const, text: `${i + 1}` })),
    ];
  }, [entry, annotations]);

  const lines = useMemo(() => {
    if (!entry) return [];
    const out = [{ id: "entry", price: entry.entryPrice, color: "#8a94a3", title: "Entry" }];
    if (entry.initialSl) out.push({ id: "sl", price: entry.initialSl, color: "#ef5350", title: "SL" });
    if (entry.initialTp) out.push({ id: "tp", price: entry.initialTp, color: "#26a69a", title: "TP" });
    return out;
  }, [entry]);

  const save = async () => {
    setSaving(true);
    try {
      const row = await api<JournalRow>(`/api/journal/${id}`, {
        method: "PATCH",
        json: {
          notes: notes || null,
          setupQuality: quality,
          ruleFollowed: rule,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          annotations,
        },
      });
      onSaved(row);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    // Full-screen sheet on phones/tablets, side drawer on wide screens.
    <aside className="fixed inset-0 z-50 flex flex-col bg-panel pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] lg:static lg:z-auto lg:w-[520px] lg:shrink-0 lg:border-l lg:border-line lg:p-0">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <h2 className="font-semibold">
          {entry ? `${entry.symbol} ${entry.direction} · ${entry.timeframe}` : "Loading…"}
        </h2>
        {entry && <span className={`num ${pnlClass(entry.netPnl)}`}>{fmtMoney(entry.netPnl, { sign: true })}</span>}
        {entry?.sessionId && (
          <a className="btn btn-ghost ml-2 text-[12px]" href={`/simulator?session=${entry.sessionId}`}>
            Open session
          </a>
        )}
        <button className="btn btn-ghost ml-auto" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div className="relative h-[240px] overflow-hidden rounded-md border border-line">
          <CandleChart
            ref={chartRef}
            tickSize={0.01}
            timeZone={timeZone}
            markers={markers}
            lines={lines}
            onChartClick={(c) => {
              if (!annotating || c.time == null) return;
              const text = prompt("Annotation text");
              if (text) setAnnotations((a) => [...a, { time: c.time!, price: c.price, text: text.slice(0, 200) }]);
              setAnnotating(false);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <button className={`btn text-[12px] ${annotating ? "border-warn text-warn" : ""}`} onClick={() => setAnnotating((a) => !a)}>
            {annotating ? "Click the chart…" : "+ Annotation"}
          </button>
          <span className="text-[11px] text-faint">Annotations are personal notes; they never alter trade data.</span>
        </div>
        {annotations.length > 0 && (
          <ol className="space-y-1 text-[12px]">
            {annotations.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-warn">{i + 1}.</span>
                <span className="num text-muted">{fmtTime(a.time, timeZone)}</span>
                <span className="flex-1">{a.text}</span>
                <button className="text-faint hover:text-down" onClick={() => setAnnotations((x) => x.filter((_, j) => j !== i))}>
                  remove
                </button>
              </li>
            ))}
          </ol>
        )}

        {entry && (
          <>
            <section>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Trade facts (immutable)</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                <Fact k="Entry" v={`${fmtPrice(entry.entryPrice)} · ${fmtTime(entry.entryTime, timeZone, true)}`} />
                <Fact k="Exit" v={`${fmtPrice(entry.exitPrice)} · ${fmtTime(entry.exitTime, timeZone, true)}`} />
                <Fact k="Quantity" v={fmtQty(entry.qty, 0.00001)} />
                <Fact k="Holding" v={fmtDuration(entry.holdingMs)} />
                <Fact k="Initial SL / TP" v={`${fmtPrice(entry.initialSl)} / ${fmtPrice(entry.initialTp)}`} />
                <Fact k="Final SL / TP" v={`${fmtPrice(entry.finalSl)} / ${fmtPrice(entry.finalTp)}`} />
                <Fact k="Gross P&L" v={fmtMoney(entry.grossPnl, { sign: true })} />
                <Fact k="Net P&L" v={fmtMoney(entry.netPnl, { sign: true })} />
                <Fact k="Fees" v={fmtMoney(entry.fees)} />
                <Fact k="Spread + slippage" v={fmtMoney(entry.slippageCost)} />
                <Fact k="Initial risk" v={fmtMoney(entry.initialRisk)} />
                <Fact k="R-multiple" v={fmtR(entry.rMultiple)} />
                <Fact k="Entry reason" v={entry.entryReason} />
                <Fact k="Exit reason" v={entry.exitReason.replace("_", " ")} />
                <Fact k="Strategy" v={entry.strategyName ?? "—"} />
                <Fact k="Mode" v={entry.mode} />
                <Fact k="Data source" v={entry.dataSource} />
                <Fact k="Data version" v={entry.dataVersion} />
              </dl>
              {entry.flags.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[12px] text-warn">
                  {entry.flags.map((f) => (
                    <li key={f}>⚠ {FLAG_LABELS[f] ?? f}</li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Executions</h3>
              <table className="data-table text-[12px]">
                <thead>
                  <tr>
                    <th>Leg</th>
                    <th>Time</th>
                    <th className="r">Price</th>
                    <th className="r">Ref</th>
                    <th className="r">Fee</th>
                    <th>Liq.</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.executions.map((e) => (
                    <tr key={e.id}>
                      <td>
                        {e.kind} · {e.reason.replace("_", " ")}
                      </td>
                      <td className="num text-muted">{fmtTime(e.time, timeZone, true)}</td>
                      <td className="r num">{fmtPrice(e.price)}</td>
                      <td className="r num text-muted">{fmtPrice(e.referencePrice)}</td>
                      <td className="r num">{fmtMoney(e.fee, { decimals: 4 })}</td>
                      <td className="text-muted">{e.liquidity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="space-y-3">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted">Your review</h3>
              <div className="flex items-center gap-6">
                <div>
                  <span className="label">Setup quality</span>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} className={`text-lg leading-none ${quality != null && n <= quality ? "text-warn" : "text-faint"}`} onClick={() => setQuality(quality === n ? null : n)}>
                        ★
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="label">Followed my rules?</span>
                  <div className="flex gap-1">
                    {[
                      [true, "Yes"],
                      [false, "No"],
                    ].map(([v, l]) => (
                      <button key={String(v)} className={`btn py-0.5 text-[12px] ${rule === v ? "border-accent" : ""}`} onClick={() => setRule(rule === v ? null : (v as boolean))}>
                        {l as string}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <label className="block">
                <span className="label">Tags (comma separated)</span>
                <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. fomo, news, a+ setup" />
              </label>
              <label className="block">
                <span className="label">Notes</span>
                <textarea className="input min-h-[110px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <button className="btn btn-primary" disabled={saving} onClick={save}>
                {saving ? "Saving…" : "Save review"}
              </button>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="num truncate text-right" title={v}>
        {v}
      </dd>
    </>
  );
}
