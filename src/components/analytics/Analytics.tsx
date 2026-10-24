"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Filters, emptyFilters, filterQuery, type FilterState } from "@/components/Filters";
import type { AnalyticsReport, GroupStat, Summary } from "@/lib/analytics/metrics";
import { MIN_RELIABLE_SAMPLE } from "@/lib/analytics/metrics";
import { api, qs } from "@/lib/client/api";
import { fmtDuration, fmtMoney, fmtPct, fmtTime, pnlClass } from "@/lib/client/format";
import { usePersistentState, useSettings, useStrategies } from "@/lib/client/hooks";

const SERIES = "#3987e5";
const DOWN = "#ef5350";
const AXIS = "#8a94a3";
const GRID = "#1b212c";

export function Analytics() {
  const { settings } = useSettings();
  const { strategies } = useStrategies();
  const [filters, setFilters] = usePersistentState<FilterState>("tl.analytics.filters", emptyFilters);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [markets, setMarkets] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tz = settings?.timeZone ?? "UTC";

  useEffect(() => {
    api<AnalyticsReport>(`/api/analytics${qs(filterQuery(filters))}`)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [filters]);
  useEffect(() => {
    api<{ facets: { symbols: string[]; markets: string[] } }>("/api/journal?limit=1").then((r) => {
      setSymbols(r.facets.symbols);
      setMarkets(r.facets.markets);
    });
  }, []);

  const s = report?.summary;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-4 p-3 md:p-4">
        <Filters value={{ ...emptyFilters, ...filters }} onChange={setFilters} strategies={strategies} symbols={symbols} markets={markets} />
        {error && <p className="text-down">{error}</p>}
        {s && report && (
          <>
            <Kpis s={s} />
            {s.warnings.length > 0 && (
              <div className="panel space-y-1 border-warn/30 p-3 text-[12px]">
                {s.warnings.map((w) => (
                  <p key={w} className="text-warn">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            )}
            {s.trades > 0 && (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="panel p-3 xl:col-span-2">
                  <h3 className="mb-2 text-[12px] text-muted">Cumulative net P&L (account currency)</h3>
                  <div className="h-[240px]">
                    <ResponsiveContainer>
                      <AreaChart data={report.equity} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                        <CartesianGrid stroke={GRID} vertical={false} />
                        <XAxis dataKey="time" tickFormatter={(t) => fmtTime(t, tz).slice(5, 10)} stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
                        <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => fmtMoney(v, { decimals: tickDecimals(report.equity.map((p) => p.equity)) })} />
                        <Tooltip content={<EquityTip tz={tz} field="equity" label="Cumulative" />} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
                        <Area type="linear" dataKey="equity" stroke={SERIES} strokeWidth={2} fill={SERIES} fillOpacity={0.12} dot={false} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <h3 className="mb-2 mt-3 text-[12px] text-muted">Drawdown from peak</h3>
                  <div className="h-[110px]">
                    <ResponsiveContainer>
                      <AreaChart data={report.equity.map((p) => ({ ...p, dd: -p.drawdown }))} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                        <CartesianGrid stroke={GRID} vertical={false} />
                        <XAxis dataKey="time" hide />
                        <YAxis stroke={AXIS} fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(v) => fmtMoney(v, { decimals: tickDecimals(report.equity.map((p) => -p.drawdown)) })} />
                        <Tooltip content={<EquityTip tz={tz} field="dd" label="Drawdown" />} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
                        <Area type="linear" dataKey="dd" stroke={DOWN} strokeWidth={2} fill={DOWN} fillOpacity={0.15} dot={false} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="panel p-3">
                  <h3 className="mb-2 text-[12px] text-muted">Costs & behaviour</h3>
                  <dl className="space-y-1.5 text-[12px]">
                    <Row k="Gross P&L (before fees)" v={fmtMoney(s.grossPnl, { sign: true })} cls={pnlClass(s.grossPnl)} />
                    <Row k="Fees paid" v={fmtMoney(s.fees)} />
                    <Row k="Spread + slippage" v={fmtMoney(s.slippage)} />
                    <Row k="Costs as share of gross edge" v={fmtPct(s.costShareOfGross)} />
                    <Row k="Payoff ratio (avg win / avg loss)" v={s.payoffRatio?.toFixed(2) ?? "—"} />
                    <Row k="Avg win / avg loss" v={`${fmtMoney(s.avgWin)} / ${fmtMoney(s.avgLoss)}`} />
                    <Row k="Max consecutive wins / losses" v={`${s.maxConsecutiveWins} / ${s.maxConsecutiveLosses}`} />
                    <Row k="Average holding time" v={fmtDuration(s.avgHoldingMs)} />
                    <Row k="Trades with a stop (R sample)" v={`${s.rSample} / ${s.trades}`} />
                  </dl>
                </div>
              </div>
            )}
            {s.trades > 0 && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <GroupTable title="Market (asset class)" groups={report.byMarket} />
                <GroupTable title="Strategy" groups={report.byStrategy} />
                <GroupTable title="Timeframe" groups={report.byTimeframe} />
                <GroupTable title="Trading session (entry, UTC)" groups={report.bySession} />
                <GroupTable title={`Day of week (entry, ${tz})`} groups={report.byDayOfWeek} />
                <GroupTable title="Long vs short" groups={report.byDirection} />
                <GroupTable title="Holding duration" groups={report.byHolding} />
                <GroupTable title="Historical vs live paper" groups={report.byMode} />
                <GroupTable title="Symbol" groups={report.bySymbol} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Kpis({ s }: { s: Summary }) {
  const tiles: [string, string, string?][] = [
    ["Trades", String(s.trades)],
    ["Win rate", fmtPct(s.winRate)],
    ["Net P&L", fmtMoney(s.netPnl, { sign: true }), pnlClass(s.netPnl)],
    ["Profit factor", fmtPF(s)],
    ["Expectancy / trade", fmtMoney(s.expectancy, { sign: true }), pnlClass(s.expectancy)],
    ["Average R", s.avgR == null ? "—" : `${s.avgR.toFixed(2)}R`, pnlClass(s.avgR)],
    ["Max drawdown", fmtMoney(s.maxDrawdown)],
    ["Fees", fmtMoney(s.fees)],
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      {tiles.map(([k, v, cls]) => (
        <div key={k} className="panel p-3">
          <div className="text-[11px] text-muted">{k}</div>
          <div className={`num mt-1 text-lg ${cls ?? ""}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function GroupTable({ title, groups }: { title: string; groups: GroupStat[] }) {
  const max = Math.max(1, ...groups.map((g) => Math.abs(g.netPnl)));
  return (
    <div className="panel overflow-x-auto">
      <h3 className="border-b border-line px-3 py-2 text-[12px] text-muted">{title}</h3>
      <table className="data-table text-[12px]">
        <thead>
          <tr>
            <th>Group</th>
            <th className="r">n</th>
            <th className="r">Win %</th>
            <th className="r">PF</th>
            <th className="r">Expectancy</th>
            <th className="r">Avg R</th>
            <th className="r">Net P&L</th>
            <th className="w-[90px]" />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const w = (Math.abs(g.netPnl) / max) * 40;
            return (
              <tr key={g.key}>
                <td>
                  {g.key}
                  {!g.reliable && (
                    <span className="ml-1.5 rounded bg-raised px-1 text-[10px] text-muted" title={`Fewer than ${MIN_RELIABLE_SAMPLE} trades: not statistically reliable`}>
                      low n
                    </span>
                  )}
                </td>
                <td className="r num">{g.trades}</td>
                <td className="r num">{fmtPct(g.winRate)}</td>
                <td className="r num">{fmtPF(g)}</td>
                <td className={`r num ${pnlClass(g.expectancy)}`}>{fmtMoney(g.expectancy, { sign: true })}</td>
                <td className="r num">{g.avgR == null ? "—" : `${g.avgR.toFixed(2)}R`}</td>
                <td className={`r num ${pnlClass(g.netPnl)}`}>{fmtMoney(g.netPnl, { sign: true })}</td>
                <td>
                  {/* Diverging bar from a zero midline: identity is also carried by the signed number. */}
                  <div className="relative h-2.5">
                    <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
                    <div
                      className="absolute inset-y-0 rounded-sm"
                      style={{ width: `${w}px`, left: g.netPnl >= 0 ? "50%" : `calc(50% - ${w}px)`, background: g.netPnl >= 0 ? "var(--up)" : "var(--down)" }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Enough decimals that a narrow P&L range still gets distinct axis labels. */
function tickDecimals(values: number[]): number {
  const range = Math.max(...values) - Math.min(...values);
  return range >= 50 ? 0 : 2;
}

function fmtPF(s: Summary): string {
  if (s.profitFactor != null) return s.profitFactor.toFixed(2);
  return s.losses === 0 && s.grossProfit > 0 ? "∞" : "—";
}

function Row({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className={`num ${cls ?? ""}`}>{v}</dd>
    </div>
  );
}

function EquityTip({ active, payload, tz, field, label }: { active?: boolean; payload?: { payload: Record<string, number> }[]; tz: string; field: string; label: string }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-line-strong bg-raised px-2 py-1.5 text-[12px] shadow">
      <div className="num text-muted">{fmtTime(p.time, tz)}</div>
      <div className="num">
        {label}: {fmtMoney(p[field], { sign: true })}
      </div>
    </div>
  );
}
