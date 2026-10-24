/**
 * Pure analytics over completed trades. No I/O; safe to use on server or client.
 */

export interface TradeRecord {
  id: string;
  symbol: string;
  /** Asset class (crypto, forex, metals, stocks, …). */
  market?: string;
  strategy: string | null;
  timeframe: string;
  direction: "long" | "short";
  mode: "historical" | "live";
  entryTime: number;
  exitTime: number;
  grossPnl: number;
  netPnl: number;
  fees: number;
  slippageCost: number;
  initialRisk: number | null;
  rMultiple: number | null;
}

/** Below this many trades a group is flagged as statistically unreliable. */
export const MIN_RELIABLE_SAMPLE = 30;

export interface Summary {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  netPnl: number;
  grossPnl: number;
  grossProfit: number;
  grossLoss: number;
  /** Null when undefined (no losing trades); JSON cannot carry Infinity. */
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  expectancy: number | null;
  avgR: number | null;
  /** R statistics only include trades that had a stop loss. */
  rSample: number;
  fees: number;
  slippage: number;
  /** Share of the pre-cost edge consumed by fees + spread/slippage. */
  costShareOfGross: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgHoldingMs: number | null;
  reliable: boolean;
  /** Plain-language warnings explaining why the numbers may not be meaningful. */
  warnings: string[];
}

export interface GroupStat extends Summary {
  key: string;
}

export interface EquityPoint {
  time: number;
  equity: number;
  drawdown: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function summarize(trades: TradeRecord[], startingEquity = 0): Summary {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const wins = sorted.filter((t) => t.netPnl > 0);
  const losses = sorted.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const netPnl = sorted.reduce((s, t) => s + t.netPnl, 0);
  const grossPnl = sorted.reduce((s, t) => s + t.grossPnl, 0);
  const fees = sorted.reduce((s, t) => s + t.fees, 0);
  const slippage = sorted.reduce((s, t) => s + t.slippageCost, 0);
  const withR = sorted.filter((t) => t.rMultiple != null);
  const n = sorted.length;

  let maxW = 0;
  let maxL = 0;
  let curW = 0;
  let curL = 0;
  for (const t of sorted) {
    if (t.netPnl > 0) {
      curW++;
      curL = 0;
    } else if (t.netPnl < 0) {
      curL++;
      curW = 0;
    } else {
      curW = 0;
      curL = 0;
    }
    maxW = Math.max(maxW, curW);
    maxL = Math.max(maxL, curL);
  }

  const curve = equityCurve(sorted, startingEquity);
  const maxDrawdown = curve.reduce((m, p) => Math.max(m, p.drawdown), 0);
  let maxDrawdownPct: number | null = null;
  if (startingEquity > 0) {
    let peak = startingEquity;
    let worst = 0;
    for (const p of curve) {
      peak = Math.max(peak, p.equity);
      worst = Math.max(worst, (peak - p.equity) / peak);
    }
    maxDrawdownPct = r4(worst * 100);
  }

  const avgWin = wins.length ? grossProfit / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const winRate = n ? wins.length / n : null;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const expectancy = n ? netPnl / n : null;
  const avgR = withR.length ? withR.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / withR.length : null;

  const warnings: string[] = [];
  if (n === 0) warnings.push("No trades in this selection.");
  else if (n < MIN_RELIABLE_SAMPLE)
    warnings.push(`Only ${n} trades — fewer than ${MIN_RELIABLE_SAMPLE}; results are not statistically reliable.`);
  if (winRate != null && winRate >= 0.6 && expectancy != null && expectancy <= 0)
    warnings.push("High win rate but non-positive expectancy: losses outweigh wins.");
  if (avgWin != null && avgLoss != null && winRate != null && winRate > 0.5 && avgWin < avgLoss * 0.5)
    warnings.push("Average loss is more than twice the average win; a small drop in win rate erases the edge.");
  if (grossPnl > 0 && netPnl <= 0) warnings.push("Profitable before costs but not after fees and slippage.");
  if (withR.length < n && n > 0) warnings.push(`${n - withR.length} trade(s) had no stop loss and are excluded from R statistics.`);

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    breakeven: n - wins.length - losses.length,
    winRate: winRate == null ? null : r4(winRate),
    netPnl: r2(netPnl),
    grossPnl: r2(grossPnl),
    grossProfit: r2(grossProfit),
    grossLoss: r2(grossLoss),
    profitFactor: profitFactor == null ? null : r2(profitFactor),
    avgWin: avgWin == null ? null : r2(avgWin),
    avgLoss: avgLoss == null ? null : r2(avgLoss),
    payoffRatio: avgWin != null && avgLoss ? r2(avgWin / avgLoss) : null,
    expectancy: expectancy == null ? null : r2(expectancy),
    avgR: avgR == null ? null : r2(avgR),
    rSample: withR.length,
    fees: r2(fees),
    slippage: r2(slippage),
    costShareOfGross: grossPnl > 0 ? r4((fees + slippage) / (grossPnl + fees + slippage)) : null,
    maxDrawdown: r2(maxDrawdown),
    maxDrawdownPct,
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    avgHoldingMs: n ? Math.round(sorted.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / n) : null,
    reliable: n >= MIN_RELIABLE_SAMPLE,
    warnings,
  };
}

export function equityCurve(trades: TradeRecord[], startingEquity = 0): EquityPoint[] {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let equity = startingEquity;
  let peak = startingEquity;
  const points = sorted.map((t) => {
    equity += t.netPnl;
    peak = Math.max(peak, equity);
    return { time: t.exitTime, equity: r2(equity), drawdown: r2(peak - equity) };
  });
  // Origin point so the curve starts from the starting equity, not the first result.
  if (sorted.length) points.unshift({ time: Math.min(...sorted.map((t) => t.entryTime)), equity: r2(startingEquity), drawdown: 0 });
  return points;
}

export function groupBy(trades: TradeRecord[], keyOf: (t: TradeRecord) => string, order?: string[]): GroupStat[] {
  const map = new Map<string, TradeRecord[]>();
  for (const t of trades) {
    const k = keyOf(t);
    const arr = map.get(k);
    if (arr) arr.push(t);
    else map.set(k, [t]);
  }
  const groups = [...map.entries()].map(([key, ts]) => ({ key, ...summarize(ts) }));
  if (order) return groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return groups.sort((a, b) => b.trades - a.trades);
}

/** Trading session by entry hour in UTC. Overlap is reported separately. */
export function tradingSession(utcMs: number): string {
  const h = new Date(utcMs).getUTCHours();
  if (h >= 12 && h < 16) return "London/NY overlap";
  if (h >= 7 && h < 12) return "London";
  if (h >= 16 && h < 21) return "New York";
  if (h >= 0 && h < 7) return "Asia";
  return "Late US / pre-Asia";
}

export const SESSION_ORDER = ["Asia", "London", "London/NY overlap", "New York", "Late US / pre-Asia"];
export const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Day of week in the display timezone (IANA name). */
export function dayOfWeek(utcMs: number, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date(utcMs));
}

const HOLD_BUCKETS: [number, string][] = [
  [15 * 60_000, "< 15m"],
  [60 * 60_000, "15m–1h"],
  [4 * 3_600_000, "1h–4h"],
  [24 * 3_600_000, "4h–1d"],
  [7 * 86_400_000, "1d–1w"],
  [Infinity, "> 1w"],
];
export const HOLD_ORDER = HOLD_BUCKETS.map(([, l]) => l);

export function holdingBucket(ms: number): string {
  return HOLD_BUCKETS.find(([max]) => ms < max)![1];
}

export interface AnalyticsReport {
  summary: Summary;
  equity: EquityPoint[];
  byDirection: GroupStat[];
  byStrategy: GroupStat[];
  byTimeframe: GroupStat[];
  bySession: GroupStat[];
  byDayOfWeek: GroupStat[];
  byHolding: GroupStat[];
  byMode: GroupStat[];
  bySymbol: GroupStat[];
  byMarket: GroupStat[];
}

export function buildReport(trades: TradeRecord[], opts: { startingEquity?: number; timeZone?: string } = {}): AnalyticsReport {
  const tz = opts.timeZone ?? "UTC";
  return {
    summary: summarize(trades, opts.startingEquity ?? 0),
    equity: equityCurve(trades, opts.startingEquity ?? 0),
    byDirection: groupBy(trades, (t) => t.direction, ["long", "short"]),
    byStrategy: groupBy(trades, (t) => t.strategy ?? "(untagged)"),
    byTimeframe: groupBy(trades, (t) => t.timeframe),
    bySession: groupBy(trades, (t) => tradingSession(t.entryTime), SESSION_ORDER),
    byDayOfWeek: groupBy(trades, (t) => dayOfWeek(t.entryTime, tz), DAY_ORDER),
    byHolding: groupBy(trades, (t) => holdingBucket(t.exitTime - t.entryTime), HOLD_ORDER),
    byMode: groupBy(trades, (t) => t.mode, ["historical", "live"]),
    bySymbol: groupBy(trades, (t) => t.symbol),
    byMarket: groupBy(trades, (t) => t.market ?? "unknown"),
  };
}
