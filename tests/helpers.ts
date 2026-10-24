import fs from "node:fs";
import path from "node:path";
import type { Bar, CostModel, EngineContext, InstrumentSpec } from "@/lib/engine/types";

type Row = [number, number, number, number, number, number];

function load(name: string): Bar[] {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")) as Row[];
  return rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

/** 48 real BTCUSDT 1h candles, 2024-03-04 00:00 → 2024-03-05 23:00 UTC (Binance). */
export const H1 = load("btcusdt-1h-2024-03-04.json");
/** 2880 real BTCUSDT 1m candles covering the same window. */
export const M1 = load("btcusdt-1m-2024-03-04.json");

export const BTC: InstrumentSpec = { symbol: "BTCUSDT", tickSize: 0.01, qtyStep: 0.00001, minQty: 0.00001, contractSize: 1 };
export const ZERO_COSTS: CostModel = { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 0, slippageBps: 0 };
export const ctx0: EngineContext = { spec: BTC, costs: ZERO_COSTS };

export const HOUR = 3_600_000;

/** Market snapshot "after bar i closed": price = close, time = next bar open. */
export function after(i: number, bars = H1) {
  return { price: bars[i].close, time: bars[i].time + HOUR };
}

export function minutesOf(bar: Bar): Bar[] {
  return M1.filter((m) => m.time >= bar.time && m.time < bar.time + HOUR);
}
