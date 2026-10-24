import { describe, expect, it } from "vitest";
import { closePosition, emptyState, placeOrder, processBar } from "@/lib/engine/engine";
import { riskPositionSize } from "@/lib/engine/sizing";
import type { EngineContext, EngineResult } from "@/lib/engine/types";
import { after, BTC, ctx0, H1, ZERO_COSTS } from "./helpers";

const SPEC = { symbol: "TEST", tickSize: 0.01, qtyStep: 0.001, minQty: 0.001, contractSize: 1 };

describe("position sizing", () => {
  it("risks exactly the budget without costs", () => {
    const r = riskPositionSize({ equity: 10_000, riskPercent: 1, entry: 100, stop: 95, side: "buy", spec: SPEC, costs: ZERO_COSTS });
    expect(r.error).toBeNull();
    expect(r.riskBudget).toBe(100);
    expect(r.qty).toBe(20);
    expect(r.estimatedLoss).toBe(100);
  });

  it("includes fees, spread and slippage in per-unit risk and rounds down", () => {
    // per unit = 5 + (100 + 95) * (10 + 5 + 1) / 10_000 = 5.312 → 100 / 5.312 = 18.8253 → 18.825
    const r = riskPositionSize({
      equity: 10_000,
      riskPercent: 1,
      entry: 100,
      stop: 95,
      side: "buy",
      spec: SPEC,
      costs: { makerFeeBps: 10, takerFeeBps: 10, spreadBps: 2, slippageBps: 5 },
    });
    expect(r.perUnitRisk).toBeCloseTo(5.312, 8);
    expect(r.qty).toBe(18.825);
    expect(r.estimatedLoss).toBeLessThanOrEqual(100);
  });

  it("sizes shorts and validates stop side", () => {
    const short = riskPositionSize({ equity: 5_000, riskPercent: 2, entry: 50, stop: 52, side: "sell", spec: SPEC, costs: ZERO_COSTS });
    expect(short.qty).toBe(50);
    const bad = riskPositionSize({ equity: 5_000, riskPercent: 2, entry: 50, stop: 49, side: "sell", spec: SPEC, costs: ZERO_COSTS });
    expect(bad.qty).toBe(0);
    expect(bad.error).toMatch(/above entry/);
  });

  it("reports when the size falls below the minimum quantity", () => {
    const r = riskPositionSize({ equity: 10, riskPercent: 0.05, entry: 60_000, stop: 59_000, side: "buy", spec: BTC, costs: ZERO_COSTS });
    expect(r.qty).toBe(0);
    expect(r.error).toMatch(/below the minimum/);
  });
});

describe("long / short profit on real BTCUSDT 1h data (zero costs)", () => {
  it("long market entry hits take profit at 07:00", () => {
    // Bought at the 00:00 close (63459.30). Bars 01:00–06:00 stay inside 63000–64000;
    // bar 07:00 trades up to 64300 → TP 64000 fills.
    let r: EngineResult = placeOrder(emptyState(10_000), { id: "L1", clientOrderId: "c1", symbol: "BTCUSDT", side: "buy", type: "market", qty: 0.1, sl: 63_000, tp: 64_000 }, after(0), ctx0);
    let state = r.state;
    expect(r.executions[0].price).toBe(63459.3);
    let closedAt = -1;
    for (let i = 1; i < 10 && closedAt < 0; i++) {
      const res = processBar(state, H1[i], ctx0);
      state = res.state;
      if (res.positions.some((p) => p.status === "closed")) {
        closedAt = i;
        r = res;
      }
    }
    expect(closedAt).toBe(7);
    const pos = r.positions[0];
    expect(pos.exitReason).toBe("take_profit");
    expect(pos.exitPrice).toBe(64000);
    expect(pos.grossPnl).toBeCloseTo(54.07, 8);
    expect(pos.netPnl).toBeCloseTo(54.07, 8);
    expect(pos.initialRisk).toBeCloseTo(45.93, 8);
    expect(state.balance).toBeCloseTo(10_054.07, 8);
  });

  it("short market entry hits take profit at 02:00", () => {
    let state = placeOrder(emptyState(10_000), { id: "S1", clientOrderId: "c2", symbol: "BTCUSDT", side: "sell", type: "market", qty: 0.1, sl: 63_900, tp: 63_200 }, after(0), ctx0).state;
    state = processBar(state, H1[1], ctx0).state; // low 63251.10 > TP
    const r = processBar(state, H1[2], ctx0); // low 63100 → TP; high 63881.66 < SL
    const pos = r.positions[0];
    expect(pos.direction).toBe("short");
    expect(pos.exitReason).toBe("take_profit");
    expect(pos.grossPnl).toBeCloseTo(25.93, 8);
  });
});

describe("fees, spread and slippage", () => {
  const costs = { makerFeeBps: 10, takerFeeBps: 10, spreadBps: 2, slippageBps: 5 };
  const c: EngineContext = { spec: { ...SPEC, qtyStep: 1, minQty: 1 }, costs };

  it("applies spread + slippage adversely on both legs and charges taker fees", () => {
    // Entry: ask 100.01, +5bp slippage = 100.060005 → rounded up to 100.07; fee 0.10007
    const placed = placeOrder(emptyState(1_000), { id: "F1", clientOrderId: "f1", symbol: "TEST", side: "buy", type: "market", qty: 1 }, { price: 100, time: 0 }, c);
    const entry = placed.executions[0];
    expect(entry.price).toBe(100.07);
    expect(entry.fee).toBeCloseTo(0.10007, 8);
    expect(entry.spreadCost).toBeCloseTo(0.01, 8);
    expect(entry.slippageCost).toBeCloseTo(0.06, 8);
    expect(entry.liquidity).toBe("taker");

    // Exit: bid 109.989, −5bp = 109.9340055 → rounded down to 109.93; fee 0.10993
    const closed = closePosition(placed.state, "pos_F1", { price: 110, time: 1 }, c);
    const pos = closed.positions[0];
    expect(pos.exitPrice).toBe(109.93);
    expect(pos.grossPnl).toBeCloseTo(9.86, 8);
    expect(pos.exitFee).toBeCloseTo(0.10993, 8);
    expect(pos.netPnl).toBeCloseTo(9.65, 8);
    expect(pos.slippageCost).toBeCloseTo(0.14, 8);
    expect(closed.state.balance).toBeCloseTo(1_009.65, 8);
  });

  it("fills limit orders at the limit price with maker fees and no slippage", () => {
    let state = placeOrder(emptyState(1_000), { id: "F2", clientOrderId: "f2", symbol: "TEST", side: "buy", type: "limit", qty: 1, price: 95 }, { price: 100, time: 0 }, c).state;
    const r = processBar(state, { time: 10, open: 99, high: 99.5, low: 94, close: 96, volume: 1 }, c);
    state = r.state;
    expect(r.executions[0].price).toBe(95);
    expect(r.executions[0].liquidity).toBe("maker");
    expect(r.executions[0].slippageCost).toBe(0);
    expect(r.executions[0].fee).toBeCloseTo(0.095, 8);
  });

  it("uses the bid for long and ask for short when checking triggers (spread matters)", () => {
    // Long TP at 101: candle high 101.005 → bid ≈ 100.9949 < 101 → NOT filled.
    let state = placeOrder(emptyState(1_000), { id: "F3", clientOrderId: "f3", symbol: "TEST", side: "buy", type: "market", qty: 1, tp: 101 }, { price: 100, time: 0 }, { ...c, costs: { ...costs, slippageBps: 0 } }).state;
    const r = processBar(state, { time: 10, open: 100, high: 101.005, low: 99.9, close: 100.5, volume: 1 }, { ...c, costs: { ...costs, slippageBps: 0 } });
    expect(r.executions).toHaveLength(0);
    state = r.state;
    expect(state.positions).toHaveLength(1);
  });
});

describe("validation", () => {
  it("rejects misplaced SL/TP and wrong-side pending prices", () => {
    const s = emptyState(1_000);
    const m = after(0);
    const bad1 = placeOrder(s, { id: "V1", clientOrderId: "v1", symbol: "BTCUSDT", side: "buy", type: "market", qty: 0.01, sl: 64_000 }, m, ctx0);
    expect(bad1.order.status).toBe("rejected");
    const bad2 = placeOrder(s, { id: "V2", clientOrderId: "v2", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 0.01, price: 70_000 }, m, ctx0);
    expect(bad2.order.rejectReason).toMatch(/below the current ask/);
    const bad3 = placeOrder(s, { id: "V3", clientOrderId: "v3", symbol: "BTCUSDT", side: "sell", type: "stop", qty: 0.01, price: 70_000 }, m, ctx0);
    expect(bad3.order.rejectReason).toMatch(/below the current bid/);
    const bad4 = placeOrder(s, { id: "V4", clientOrderId: "v4", symbol: "BTCUSDT", side: "buy", type: "market", qty: 0.000001 }, m, ctx0);
    expect(bad4.order.rejectReason).toMatch(/at least/);
  });
});
