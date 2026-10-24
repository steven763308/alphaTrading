import { describe, expect, it } from "vitest";
import { buildReport, summarize, tradingSession, type TradeRecord } from "@/lib/analytics/metrics";
import { parseOhlcvCsv } from "@/lib/market/csv";

let n = 0;
const t = (netPnl: number, extra: Partial<TradeRecord> = {}): TradeRecord => {
  n++;
  return {
    id: String(n),
    symbol: "BTCUSDT",
    strategy: "Breakout",
    timeframe: "1h",
    direction: "long",
    mode: "historical",
    entryTime: Date.UTC(2024, 0, 1, 9) + n * 3_600_000,
    exitTime: Date.UTC(2024, 0, 1, 10) + n * 3_600_000,
    grossPnl: netPnl + 1,
    netPnl,
    fees: 1,
    slippageCost: 0,
    initialRisk: 100,
    rMultiple: netPnl / 100,
    ...extra,
  };
};

describe("analytics summary", () => {
  // Fixture: +200, −100, +150, −100, −100, +300 (net +350)
  const trades = [t(200), t(-100), t(150), t(-100), t(-100), t(300)];

  it("computes core statistics", () => {
    const s = summarize(trades, 10_000);
    expect(s.trades).toBe(6);
    expect(s.winRate).toBe(0.5);
    expect(s.netPnl).toBe(350);
    expect(s.grossProfit).toBe(650);
    expect(s.grossLoss).toBe(300);
    expect(s.profitFactor).toBe(2.17);
    expect(s.avgWin).toBe(216.67);
    expect(s.avgLoss).toBe(100);
    expect(s.expectancy).toBe(58.33);
    expect(s.avgR).toBe(0.58);
    expect(s.maxConsecutiveLosses).toBe(2);
    expect(s.maxConsecutiveWins).toBe(1);
    // Equity: 10200, 10100, 10250, 10150, 10050, 10350 → max DD = 10250 − 10050 = 200
    expect(s.maxDrawdown).toBe(200);
    expect(s.maxDrawdownPct).toBeCloseTo(1.9512, 3);
    expect(s.fees).toBe(6);
  });

  it("flags small samples as unreliable", () => {
    const s = summarize(trades);
    expect(s.reliable).toBe(false);
    expect(s.warnings.join(" ")).toMatch(/not statistically reliable/);
  });

  it("warns when a high win rate hides negative expectancy", () => {
    const s = summarize([t(10), t(10), t(10), t(10), t(-100)]);
    expect(s.winRate).toBe(0.8);
    expect(s.warnings.join(" ")).toMatch(/High win rate but non-positive expectancy/);
  });

  it("warns when costs turn a gross profit into a net loss", () => {
    const s = summarize([t(-1, { grossPnl: 5 }), t(-1, { grossPnl: 5 })]);
    expect(s.warnings.join(" ")).toMatch(/not after fees/);
  });

  it("groups with sample sizes in every bucket", () => {
    const r = buildReport([...trades, t(50, { direction: "short", strategy: null, mode: "live" })]);
    expect(r.byDirection.map((g) => [g.key, g.trades])).toEqual([["long", 6], ["short", 1]]);
    expect(r.byStrategy.find((g) => g.key === "(untagged)")?.trades).toBe(1);
    expect(r.byMode.map((g) => g.key)).toEqual(["historical", "live"]);
    expect(r.equity).toHaveLength(8); // origin point + 7 trades
  });

  it("buckets trading sessions by UTC hour", () => {
    expect(tradingSession(Date.UTC(2024, 0, 1, 3))).toBe("Asia");
    expect(tradingSession(Date.UTC(2024, 0, 1, 8))).toBe("London");
    expect(tradingSession(Date.UTC(2024, 0, 1, 13))).toBe("London/NY overlap");
    expect(tradingSession(Date.UTC(2024, 0, 1, 18))).toBe("New York");
  });
});

describe("CSV parsing", () => {
  it("parses headered CSV with ISO times, dedupes and counts gaps", () => {
    const csv = [
      "Date,Open,High,Low,Close,Volume",
      "2024-01-01 00:00:00,10,11,9,10.5,100",
      "2024-01-01 01:00:00,10.5,12,10,11,100",
      "2024-01-01 01:00:00,10.5,12,10,11,100",
      "2024-01-01 04:00:00,11,11.5,10.5,11.2,100",
    ].join("\n");
    const r = parseOhlcvCsv(csv, 3_600_000);
    expect(r.bars).toHaveLength(3);
    expect(r.bars[0].time).toBe(Date.UTC(2024, 0, 1, 0));
    expect(r.duplicates).toBe(1);
    expect(r.gaps).toBe(2);
  });

  it("parses headerless Binance kline dumps (ms and µs timestamps)", () => {
    const r = parseOhlcvCsv("1709510400000,63113.97,64268.24,62300,63459.3,1000,1709513999999\n1709514000000000,63459.29,63833.02,63251.1,63512.41,900,0");
    expect(r.bars.map((b) => b.time)).toEqual([1709510400000, 1709514000000]);
  });

  it("rejects inconsistent rows instead of guessing", () => {
    const r = parseOhlcvCsv("time,open,high,low,close\n2024-01-01T00:00:00Z,10,9,8,9.5");
    expect(r.bars).toHaveLength(0);
    expect(r.errors[0]).toMatch(/inconsistent/);
  });
});
