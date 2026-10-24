import { describe, expect, it } from "vitest";
import { cancelOrder, emptyState, modifyPosition, needsIntrabarResolution, placeOrder, processBar } from "@/lib/engine/engine";
import { EngineError } from "@/lib/engine/types";
import { after, ctx0, H1, minutesOf } from "./helpers";

describe("pending orders", () => {
  it("buy limit fills on a later bar at the limit price", () => {
    // After 02:00 close (63687.43) place buy limit 63400; 03:00 low is 63355.
    const s = placeOrder(emptyState(10_000), { id: "P1", clientOrderId: "p1", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 0.1, price: 63_400 }, after(2), ctx0).state;
    const r = processBar(s, H1[3], ctx0);
    expect(r.executions).toHaveLength(1);
    expect(r.executions[0].price).toBe(63_400);
    expect(r.executions[0].time).toBe(H1[3].time);
    expect(r.state.positions[0].entryPrice).toBe(63_400);
  });

  it("buy stop triggers on 07:00 at the stop price", () => {
    const s = placeOrder(emptyState(10_000), { id: "P2", clientOrderId: "p2", symbol: "BTCUSDT", side: "buy", type: "stop", qty: 0.1, price: 64_000 }, after(6), ctx0).state;
    const r = processBar(s, H1[7], ctx0);
    expect(r.executions[0].price).toBe(64_000);
    expect(r.executions[0].liquidity).toBe("taker");
  });

  it("fills at the open when the bar gaps through the order (synthetic gap)", () => {
    const s = placeOrder(emptyState(10_000), { id: "P3", clientOrderId: "p3", symbol: "BTCUSDT", side: "buy", type: "stop", qty: 1, price: 105 }, { price: 100, time: 0 }, ctx0).state;
    const r = processBar(s, { time: 1, open: 108, high: 110, low: 107, close: 109, volume: 0 }, ctx0);
    expect(r.executions[0].price).toBe(108);
    expect(r.executions[0].flags).toContain("gap_open");
  });

  it("cancels pending orders", () => {
    const s = placeOrder(emptyState(10_000), { id: "P4", clientOrderId: "p4", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 0.1, price: 63_000 }, after(2), ctx0).state;
    const r = cancelOrder(s, "P4", after(2).time);
    expect(r.state.orders).toHaveLength(0);
    expect(r.orders[0].status).toBe("cancelled");
    expect(() => cancelOrder(r.state, "P4", 0)).toThrow(EngineError);
  });
});

describe("look-ahead prevention", () => {
  it("an order cannot fill on the bar that was already visible when it was placed", () => {
    // Placed after 03:00 closed. Bar 03:00 itself (low 63355) must not fill a 63400 buy limit.
    const s = placeOrder(emptyState(10_000), { id: "LA", clientOrderId: "la", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 0.1, price: 63_400 }, after(3), ctx0).state;
    expect(processBar(s, H1[3], ctx0).executions).toHaveLength(0);
    // 04:00 low 63366.31 does fill it.
    expect(processBar(s, H1[4], ctx0).executions).toHaveLength(1);
  });

  it("a position cannot exit on price action from before its entry", () => {
    const s = placeOrder(emptyState(10_000), { id: "LB", clientOrderId: "lb", symbol: "BTCUSDT", side: "buy", type: "market", qty: 0.1, sl: 63_300 }, after(5), ctx0).state;
    // Bar 05:00 (low 63210) was before entry; re-processing it must not stop the trade.
    expect(processBar(s, H1[5], ctx0).executions).toHaveLength(0);
  });

  it("modified levels must be valid at the current price", () => {
    const s = placeOrder(emptyState(10_000), { id: "LC", clientOrderId: "lc", symbol: "BTCUSDT", side: "buy", type: "market", qty: 0.1 }, after(0), ctx0).state;
    expect(() => modifyPosition(s, "pos_LC", { sl: 63_500 }, after(0), ctx0)).toThrow(/below/);
    expect(modifyPosition(s, "pos_LC", { sl: 63_000 }, after(0), ctx0).state.positions[0].sl).toBe(63_000);
  });
});

describe("stop loss / take profit", () => {
  it("stop loss fills at the stop price", () => {
    // Long after 04:00 close (63634.36), SL 63250 → 05:00 low 63210 hits it.
    const s = placeOrder(emptyState(10_000), { id: "SL", clientOrderId: "sl", symbol: "BTCUSDT", side: "buy", type: "market", qty: 0.1, sl: 63_250 }, after(4), ctx0).state;
    const r = processBar(s, H1[5], ctx0);
    expect(r.positions[0].exitReason).toBe("stop_loss");
    expect(r.positions[0].exitPrice).toBe(63_250);
    expect(r.positions[0].netPnl).toBeCloseTo((63_250 - 63_634.36) * 0.1, 8);
  });

  it("a gap through the stop fills at the (worse) open price", () => {
    const s = placeOrder(emptyState(10_000), { id: "GS", clientOrderId: "gs", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1, sl: 95 }, { price: 100, time: 0 }, ctx0).state;
    const r = processBar(s, { time: 1, open: 90, high: 92, low: 89, close: 91, volume: 0 }, ctx0);
    expect(r.positions[0].exitPrice).toBe(90);
    expect(r.executions[0].flags).toContain("gap_open");
  });
});

describe("SL and TP touched in the same candle", () => {
  // Short after the 07:00 close (64066.62). Bar 08:00: high 65500 (≥ SL 65400) and
  // low 64000.11 (≤ TP 64010) — both touched.
  const open = () =>
    placeOrder(emptyState(10_000), { id: "AMB", clientOrderId: "amb", symbol: "BTCUSDT", side: "sell", type: "market", qty: 0.1, sl: 65_400, tp: 64_010 }, after(7), ctx0).state;

  it("assumes the stop loss hit first without lower-timeframe data (conservative)", () => {
    const s = open();
    expect(needsIntrabarResolution(s, H1[8], ctx0)).toBe(true);
    const r = processBar(s, H1[8], ctx0);
    expect(r.ambiguous).toBe(true);
    expect(r.positions[0].exitReason).toBe("stop_loss");
    expect(r.positions[0].exitPrice).toBe(65_400);
    expect(r.executions[0].flags).toContain("ambiguous_sl_tp");
    expect(r.positions[0].netPnl).toBeCloseTo(-133.338, 8);
  });

  it("resolves with real 1m candles: TP was actually hit first at 08:00", () => {
    // 1m bar 08:00 has low 64008.55 (≤ TP) and high 64093.15 (< SL).
    const s = open();
    const r = processBar(s, H1[8], ctx0, { subBars: minutesOf(H1[8]) });
    expect(r.positions[0].exitReason).toBe("take_profit");
    expect(r.positions[0].exitPrice).toBe(64_010);
    expect(r.executions[0].flags).toContain("resolved_lower_tf");
    expect(r.executions[0].time).toBe(H1[8].time);
    expect(r.positions[0].netPnl).toBeCloseTo(5.662, 8);
  });

  it("never assumes TP on the bar a pending entry filled mid-bar", () => {
    // Buy limit 63400 placed after 02:00; 03:00 fills it (low 63355) and also
    // trades up to 63754.45. TP 63700 must NOT be assumed hit on the entry bar.
    const s = placeOrder(emptyState(10_000), { id: "EB", clientOrderId: "eb", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 0.1, price: 63_400, tp: 63_700, sl: 63_000 }, after(2), ctx0).state;
    const r = processBar(s, H1[3], ctx0);
    expect(r.ambiguous).toBe(true);
    expect(r.state.positions).toHaveLength(1);
    expect(r.executions.map((e) => e.kind)).toEqual(["entry"]);
  });

  it("assumes SL hit when touched on the entry bar", () => {
    const s = placeOrder(emptyState(10_000), { id: "EB2", clientOrderId: "eb2", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 0.1, price: 63_400, sl: 63_360 }, after(2), ctx0).state;
    const r = processBar(s, H1[3], ctx0); // low 63355 ≤ SL 63360
    expect(r.positions[0].exitReason).toBe("stop_loss");
    expect(r.executions[1].flags).toContain("ambiguous_entry_bar");
  });
});

describe("live segments", () => {
  it("applies entry-bar rules to a position opened inside a partial segment", () => {
    const s = placeOrder(emptyState(10_000), { id: "SEG", clientOrderId: "seg", symbol: "BTCUSDT", side: "buy", type: "market", qty: 1, sl: 99, tp: 101 }, { price: 100, time: 1_500 }, ctx0).state;
    // Segment [1000, 3000] includes the entry at 1500: TP never assumed, SL would be.
    const tpOnly = processBar(s, { time: 1_000, open: 100, high: 101.5, low: 99.5, close: 100.2, volume: 0, end: 3_000 }, ctx0);
    expect(tpOnly.executions).toHaveLength(0);
    const slTouched = processBar(s, { time: 1_000, open: 100, high: 100.2, low: 98.9, close: 99.5, volume: 0, end: 3_000 }, ctx0);
    expect(slTouched.positions[0].exitReason).toBe("stop_loss");
    expect(slTouched.positions[0].exitTime).toBe(1_500);
    // A segment entirely before the entry is ignored.
    expect(processBar(s, { time: 0, open: 100, high: 100, low: 90, close: 95, volume: 0, end: 1_000 }, ctx0).executions).toHaveLength(0);
  });
});
