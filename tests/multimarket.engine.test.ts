import { describe, expect, it } from "vitest";
import { closePosition, emptyState, placeOrder, processBar } from "@/lib/engine/engine";
import { riskPositionSize } from "@/lib/engine/sizing";
import type { Bar, CostModel, EngineContext, InstrumentSpec } from "@/lib/engine/types";
import { marketStatus, nyseHolidays, rollovers } from "@/lib/market/calendars";

const ZERO: CostModel = { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 0, slippageBps: 0 };
const XAU: InstrumentSpec = { symbol: "XAUUSD", tickSize: 0.01, qtyStep: 0.01, minQty: 0.01, contractSize: 100, leverage: 20 };
const EURUSD: InstrumentSpec = { symbol: "EURUSD", tickSize: 0.00001, qtyStep: 0.01, minQty: 0.01, contractSize: 100_000, leverage: 30 };
const USDJPY: InstrumentSpec = { symbol: "USDJPY", tickSize: 0.001, qtyStep: 0.01, minQty: 0.01, contractSize: 100_000, leverage: 30 };
const EURGBP: InstrumentSpec = { symbol: "EURGBP", tickSize: 0.00001, qtyStep: 0.01, minQty: 0.01, contractSize: 100_000, leverage: 30 };
const AAPL: InstrumentSpec = { symbol: "AAPL", tickSize: 0.01, qtyStep: 1, minQty: 1, contractSize: 1, leverage: 1 };

const bar = (time: number, o: number, h: number, l: number, c: number, extra: Partial<Bar> = {}): Bar => ({ time, open: o, high: h, low: l, close: c, volume: 1, ...extra });
const buy = (id: string, symbol: string, qty: number, extra: Record<string, unknown> = {}) => ({ id, clientOrderId: id, symbol, side: "buy" as const, type: "market" as const, qty, ...extra });

describe("market-specific sizing", () => {
  it("XAUUSD: 1% of 10,000 with a $10 stop on 100-oz lots = 0.10 lots", () => {
    const r = riskPositionSize({ equity: 10_000, riskPercent: 1, entry: 2040, stop: 2030, side: "buy", spec: XAU, costs: ZERO });
    expect(r.perUnitRisk).toBe(1000); // $10 × 100 oz
    expect(r.qty).toBe(0.1);
  });

  it("EURUSD: 20-pip stop = $200/lot → 0.50 lots for $100 risk; commission adds per-lot cost", () => {
    const r = riskPositionSize({ equity: 10_000, riskPercent: 1, entry: 1.08, stop: 1.078, side: "buy", spec: EURUSD, costs: ZERO });
    expect(r.perUnitRisk).toBeCloseTo(200, 6);
    expect(r.qty).toBe(0.5);
    const withComm = riskPositionSize({ equity: 10_000, riskPercent: 1, entry: 1.08, stop: 1.078, side: "buy", spec: EURUSD, costs: { ...ZERO, commissionPerUnit: 3.5 } });
    expect(withComm.perUnitRisk).toBeCloseTo(207, 6); // + 2 × $3.50
    expect(withComm.qty).toBe(0.48);
  });

  it("USDJPY: risk in JPY converted to USD at the stop price", () => {
    // 1 yen stop × 100,000 = ¥100,000 per lot ÷ 149 = $671.14 → $100 / 671.14 = 0.149 → 0.14 lots
    const r = riskPositionSize({ equity: 10_000, riskPercent: 1, entry: 150, stop: 149, side: "buy", spec: USDJPY, costs: ZERO, conversion: { kind: "inverse" } });
    expect(r.perUnitRisk).toBeCloseTo(100_000 / 149, 6);
    expect(r.qty).toBe(0.14);
  });

  it("stocks size in whole shares", () => {
    const r = riskPositionSize({ equity: 10_000, riskPercent: 1, entry: 190, stop: 187, side: "buy", spec: AAPL, costs: ZERO });
    expect(r.qty).toBe(33); // $100 / $3 = 33.3 → 33 shares
  });
});

describe("market-specific P&L and currency conversion", () => {
  it("XAUUSD: 0.10 lot from 2040 to 2050 = +$100", () => {
    const ctx: EngineContext = { spec: XAU, costs: ZERO };
    const s = placeOrder(emptyState(10_000), buy("X1", "XAUUSD", 0.1), { price: 2040, time: 0 }, ctx).state;
    const r = closePosition(s, "pos_X1", { price: 2050, time: 1 }, ctx);
    expect(r.positions[0].grossPnl).toBeCloseTo(100, 8);
    expect(r.positions[0].margin).toBeCloseTo((2040 * 0.1 * 100) / 20, 8); // $1,020
  });

  it("EURUSD: 1 lot +10 pips = $100; $3.50/lot/side commission → net $93", () => {
    const ctx: EngineContext = { spec: EURUSD, costs: { ...ZERO, commissionPerUnit: 3.5 } };
    const s = placeOrder(emptyState(10_000), buy("E1", "EURUSD", 1), { price: 1.08, time: 0 }, ctx).state;
    const r = closePosition(s, "pos_E1", { price: 1.081, time: 1 }, ctx);
    expect(r.positions[0].grossPnl).toBeCloseTo(100, 6);
    expect(r.positions[0].entryFee + r.positions[0].exitFee).toBeCloseTo(7, 8);
    expect(r.positions[0].netPnl).toBeCloseTo(93, 6);
    expect(r.state.balance).toBeCloseTo(10_093, 6);
  });

  it("USDJPY: ¥100,000 profit converted at the exit price (151) = $662.25", () => {
    const ctx: EngineContext = { spec: USDJPY, costs: ZERO, conversion: { kind: "inverse" } };
    const placed = placeOrder(emptyState(10_000), buy("J1", "USDJPY", 1), { price: 150, time: 0 }, ctx);
    expect(placed.executions[0].fxRate).toBeCloseTo(1 / 150, 10);
    const r = closePosition(placed.state, "pos_J1", { price: 151, time: 1 }, ctx);
    expect(r.positions[0].grossPnl).toBeCloseTo(100_000 / 151, 6);
    expect(r.executions[0].fxRate).toBeCloseTo(1 / 151, 10);
  });

  it("EURGBP: GBP P&L converted with an external GBPUSD rate", () => {
    const ctx: EngineContext = { spec: EURGBP, costs: ZERO, conversion: { kind: "rate", rate: 1.27 } };
    const s = placeOrder(emptyState(10_000), buy("G1", "EURGBP", 1), { price: 0.855, time: 0 }, ctx).state;
    const r = closePosition(s, "pos_G1", { price: 0.856, time: 1 }, ctx);
    expect(r.positions[0].grossPnl).toBeCloseTo(100 * 1.27, 6); // £100 × 1.27
  });
});

describe("margin and leverage", () => {
  const ctx: EngineContext = { spec: XAU, costs: ZERO, margin: { otherUsedMargin: 0, otherUnrealized: 0, stopOutLevelPct: 50 } };

  it("rejects orders that exceed free margin", () => {
    const r = placeOrder(emptyState(1_000), buy("M1", "XAUUSD", 1), { price: 2000, time: 0 }, ctx);
    expect(r.order.status).toBe("rejected");
    expect(r.order.rejectReason).toMatch(/Insufficient margin: needs 10000\.00, free 1000\.00/);
    expect(placeOrder(emptyState(1_000), buy("M2", "XAUUSD", 0.05), { price: 2000, time: 0 }, ctx).order.status).toBe("filled");
  });

  it("counts exposure on other symbols", () => {
    const busy: EngineContext = { ...ctx, margin: { otherUsedMargin: 800, otherUnrealized: -100, stopOutLevelPct: 50 } };
    // free = 1000 − 100 − 800 = 100 < 0.01 lot margin (100) + 0? → exactly 100 → allowed; 0.02 lot → rejected
    expect(placeOrder(emptyState(1_000), buy("M3", "XAUUSD", 0.01), { price: 2000, time: 0 }, busy).order.status).toBe("filled");
    expect(placeOrder(emptyState(1_000), buy("M4", "XAUUSD", 0.02), { price: 2000, time: 0 }, busy).order.status).toBe("rejected");
  });

  it("rejects a pending order at fill time if margin is gone", () => {
    // P1 needs 1990 × 0.05 × 100 / 20 = $497.50 at fill.
    let s = placeOrder(emptyState(1_000), { ...buy("P1", "XAUUSD", 0.05), type: "limit", price: 1990 }, { price: 2000, time: 0 }, ctx).state;
    s = placeOrder(s, buy("P2", "XAUUSD", 0.05), { price: 2000, time: 0 }, ctx).state; // uses $500 margin
    // At the 1990 fill: free = 1000 − 50 unrealized − 500 used = $450 < $497.50.
    const r = processBar(s, bar(10, 1995, 1996, 1985, 1990), ctx);
    expect(r.orders.find((o) => o.id === "P1")?.status).toBe("rejected");
    expect(r.orders.find((o) => o.id === "P1")?.rejectReason).toMatch(/at fill/);
  });

  it("stops out at the bar close when margin level < 50%", () => {
    // 0.09 lot @ 2000 → margin $900. Close 1940: equity 1000 − 540 = 460 → 51% (survives).
    // Close 1938: equity 442 → 49.1% → stop-out at the close.
    const s = placeOrder(emptyState(1_000), buy("S1", "XAUUSD", 0.09), { price: 2000, time: 0 }, ctx).state;
    expect(processBar(s, bar(10, 1999, 2000, 1939, 1940), ctx).executions).toHaveLength(0);
    const r = processBar(s, bar(10, 1999, 2000, 1937, 1938), ctx);
    expect(r.positions[0].exitReason).toBe("stop_out");
    expect(r.positions[0].exitPrice).toBe(1938);
    expect(r.executions[0].flags).toContain("stop_out");
  });

  it("legacy specs without leverage skip margin checks", () => {
    const c: EngineContext = { spec: { ...XAU, leverage: undefined }, costs: ZERO };
    expect(placeOrder(emptyState(10), buy("L1", "XAUUSD", 10), { price: 2000, time: 0 }, c).order.status).toBe("filled");
  });
});

describe("observed bid/ask spread per bar", () => {
  it("uses the bar's real spread for trigger checks", () => {
    const ctx: EngineContext = { spec: XAU, costs: ZERO };
    // Bar low 2000 with a 0.40 spread → ask low 2000.20.
    const b = bar(10, 2005, 2006, 2000, 2003, { spread: 0.4 });
    const tooLow = placeOrder(emptyState(10_000), { ...buy("B1", "XAUUSD", 0.1), type: "limit", price: 2000.1 }, { price: 2004, time: 0 }, ctx).state;
    expect(processBar(tooLow, b, ctx).executions).toHaveLength(0);
    const ok = placeOrder(emptyState(10_000), { ...buy("B2", "XAUUSD", 0.1), type: "limit", price: 2000.2 }, { price: 2004, time: 0 }, ctx).state;
    expect(processBar(ok, b, ctx).executions[0].price).toBe(2000.2);
  });
});

describe("financing / swaps", () => {
  const spec: InstrumentSpec = { ...XAU, financing: { longAnnualPct: -6, shortAnnualPct: -1, tripleDay: 3 } };
  const ctx: EngineContext = { spec, costs: ZERO, barMs: 3_600_000 };
  // 2024-02-07 is a Wednesday; 17:00 New York (EST) = 22:00 UTC.
  const wedRoll = Date.UTC(2024, 1, 7, 22);
  const tueRoll = Date.UTC(2024, 1, 6, 22);

  it("charges triple financing on the Wednesday rollover", () => {
    const s = placeOrder(emptyState(100_000), buy("F1", "XAUUSD", 1), { price: 2000, time: wedRoll - 5 * 3_600_000 }, ctx).state;
    const r = processBar(s, bar(wedRoll - 3_600_000 + 1, 2000, 2001, 1999, 2000), ctx); // window includes 22:00
    const expected = (2000 * 100 * -6) / 100 / 365 * 3;
    expect(r.positions[0].financing).toBeCloseTo(expected, 6); // ≈ −98.63
    expect(r.state.balance).toBeCloseTo(100_000 + expected, 6);
    expect(r.events.some((e) => e.type === "position_financed")).toBe(true);
  });

  it("charges one day on other weekdays and includes financing in net P&L", () => {
    const s = placeOrder(emptyState(100_000), buy("F2", "XAUUSD", 1), { price: 2000, time: tueRoll - 5 * 3_600_000 }, ctx).state;
    const r = processBar(s, bar(tueRoll - 3_600_000 + 1, 2000, 2001, 1999, 2000), ctx);
    const oneDay = (2000 * 100 * -6) / 100 / 365;
    expect(r.positions[0].financing).toBeCloseTo(oneDay, 6);
    const closed = closePosition(r.state, "pos_F2", { price: 2000, time: tueRoll + 1 }, ctx);
    expect(closed.positions[0].netPnl).toBeCloseTo(oneDay, 6);
  });

  it("does not charge positions opened after the rollover", () => {
    const s = placeOrder(emptyState(100_000), buy("F3", "XAUUSD", 1), { price: 2000, time: tueRoll + 60_000 }, ctx).state;
    expect(processBar(s, bar(tueRoll - 3_600_000 + 1, 2000, 2001, 1999, 2000), ctx).positions).toHaveLength(0);
  });
});

describe("sessions", () => {
  it("refuses market orders and manual closes while the market is closed", () => {
    const closed: EngineContext = { spec: XAU, costs: ZERO, marketOpen: false };
    expect(placeOrder(emptyState(10_000), buy("C1", "XAUUSD", 0.1), { price: 2000, time: 0 }, closed).order.rejectReason).toMatch(/Market is closed/);
    const limit = placeOrder(emptyState(10_000), { ...buy("C2", "XAUUSD", 0.1), type: "limit", price: 1990 }, { price: 2000, time: 0 }, closed);
    expect(limit.order.status).toBe("pending");
    const open = placeOrder(emptyState(10_000), buy("C3", "XAUUSD", 0.1), { price: 2000, time: 0 }, { spec: XAU, costs: ZERO }).state;
    expect(() => closePosition(open, "pos_C3", { price: 2000, time: 1 }, closed)).toThrow(/closed/);
  });

  it("FX: closed Friday 17:00 → Sunday 17:00 New York (DST-aware)", () => {
    expect(marketStatus("fx", Date.UTC(2024, 1, 9, 21, 59)).open).toBe(true); // Fri 16:59 EST
    expect(marketStatus("fx", Date.UTC(2024, 1, 9, 22, 0)).open).toBe(false); // Fri 17:00 EST
    expect(marketStatus("fx", Date.UTC(2024, 1, 10, 12)).open).toBe(false); // Saturday
    expect(marketStatus("fx", Date.UTC(2024, 1, 11, 21, 59)).open).toBe(false); // Sun 16:59 EST
    expect(marketStatus("fx", Date.UTC(2024, 1, 11, 22, 0)).open).toBe(true); // Sun 17:00 EST
    expect(marketStatus("fx", Date.UTC(2024, 6, 12, 21, 0)).open).toBe(false); // Fri 17:00 EDT (summer)
  });

  it("metals have a daily 17:00–18:00 New York break", () => {
    expect(marketStatus("metals", Date.UTC(2024, 1, 7, 22, 30)).open).toBe(false);
    expect(marketStatus("metals", Date.UTC(2024, 1, 7, 23, 0)).open).toBe(true);
    expect(marketStatus("fx", Date.UTC(2024, 1, 7, 22, 30)).open).toBe(true);
  });

  it("US equities: 09:30–16:00 New York and NYSE holidays", () => {
    expect(marketStatus("us_equity", Date.UTC(2024, 1, 7, 14, 29)).open).toBe(false); // 09:29 EST
    expect(marketStatus("us_equity", Date.UTC(2024, 1, 7, 14, 30)).open).toBe(true);
    expect(marketStatus("us_equity", Date.UTC(2024, 6, 8, 13, 30)).open).toBe(true); // 09:30 EDT
    expect(marketStatus("us_equity", Date.UTC(2024, 1, 7, 21, 0)).open).toBe(false); // 16:00 EST
    expect(marketStatus("us_equity", Date.UTC(2024, 6, 4, 15)).reason).toBe("NYSE holiday");
    const h24 = nyseHolidays(2024);
    for (const d of ["2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25"]) expect(h24.has(d)).toBe(true);
    expect(nyseHolidays(2022).has("2022-06-20")).toBe(true); // Juneteenth observed Monday
    expect(nyseHolidays(2021).has("2021-12-31")).toBe(false); // New Year on Saturday is not observed
    expect(nyseHolidays(2021).has("2021-04-02")).toBe(true); // Good Friday 2021
  });

  it("rollovers: five per trading week, Wednesday tripled", () => {
    const week = rollovers(Date.UTC(2024, 1, 4), Date.UTC(2024, 1, 11), 3); // Sun → Sun
    expect(week).toHaveLength(5);
    expect(week.map((r) => r.days)).toEqual([1, 1, 3, 1, 1]);
    expect(week[0].time).toBe(Date.UTC(2024, 1, 5, 22)); // Mon 17:00 EST
    const summer = rollovers(Date.UTC(2024, 6, 8), Date.UTC(2024, 6, 9), null);
    expect(summer[0].time).toBe(Date.UTC(2024, 6, 8, 21)); // 17:00 EDT
  });
});
