import type { Conversion, CostModel, Direction, InstrumentSpec, Side } from "./types";

const BPS = 10_000;

export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8;
  const s = step.toExponential();
  const [mantissa, exp] = s.split("e");
  const mantDecimals = (mantissa.split(".")[1] ?? "").length;
  return Math.max(0, mantDecimals - Number(exp));
}

/** Round to a fixed number of decimals, removing binary floating point noise. */
export function round(value: number, decimals = 8): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
}

export type RoundMode = "nearest" | "up" | "down";

export function roundToStep(value: number, step: number, mode: RoundMode = "nearest"): number {
  const decimals = decimalsOf(step);
  // Tolerate float noise such as 0.30000000000000004 before floor/ceil.
  const units = round(value / step, 6);
  const n = mode === "up" ? Math.ceil(units) : mode === "down" ? Math.floor(units) : Math.round(units);
  return round(n * step, decimals);
}

export function directionOf(side: Side): Direction {
  return side === "buy" ? "long" : "short";
}

export function entrySide(direction: Direction): Side {
  return direction === "long" ? "buy" : "sell";
}

export function exitSide(direction: Direction): Side {
  return direction === "long" ? "sell" : "buy";
}

/** Ask is above the candle price, bid below, each by half the spread. */
export function askOf(price: number, costs: CostModel): number {
  return price * (1 + costs.spreadBps / 2 / BPS);
}

export function bidOf(price: number, costs: CostModel): number {
  return price * (1 - costs.spreadBps / 2 / BPS);
}

/** Price a given side trades at: buys at the ask, sells at the bid. */
export function sidePrice(price: number, side: Side, costs: CostModel): number {
  return side === "buy" ? askOf(price, costs) : bidOf(price, costs);
}

/** Inverse of sidePrice: candle price at which the side's quote equals `quote`. */
export function candlePriceFor(quote: number, side: Side, costs: CostModel): number {
  const h = costs.spreadBps / 2 / BPS;
  return side === "buy" ? quote / (1 + h) : quote / (1 - h);
}

export function applySlippage(price: number, side: Side, costs: CostModel): number {
  const s = costs.slippageBps / BPS;
  return side === "buy" ? price * (1 + s) : price * (1 - s);
}

/** Round a fill price to the tick size, always against the trader. */
export function roundFill(price: number, side: Side, spec: InstrumentSpec): number {
  return roundToStep(price, spec.tickSize, side === "buy" ? "up" : "down");
}

export function feeFor(price: number, qty: number, spec: InstrumentSpec, feeBps: number): number {
  return round(price * qty * spec.contractSize * (feeBps / BPS), 8);
}

export function grossPnl(direction: Direction, entry: number, exit: number, qty: number, spec: InstrumentSpec): number {
  const diff = direction === "long" ? exit - entry : entry - exit;
  return round(diff * qty * spec.contractSize, 8);
}

/** Quote→account rate for an amount realised when the instrument trades at `price`. */
export function fxRate(price: number, conversion: Conversion | undefined): number {
  if (!conversion || conversion.kind === "identity") return 1;
  if (conversion.kind === "inverse") return price > 0 ? 1 / price : 0;
  return conversion.rate;
}

export function toAccount(amountQuote: number, price: number, conversion: Conversion | undefined): number {
  return round(amountQuote * fxRate(price, conversion), 8);
}

/** Position notional in account currency. */
export function notional(price: number, qty: number, spec: InstrumentSpec, conversion?: Conversion): number {
  return toAccount(price * qty * spec.contractSize, price, conversion);
}

/** Margin required for a position (account currency). 0 when the spec has no leverage. */
export function marginFor(price: number, qty: number, spec: InstrumentSpec, conversion?: Conversion): number {
  if (!spec.leverage) return 0;
  return round(notional(price, qty, spec, conversion) / spec.leverage, 8);
}

/** Effective costs for a bar: an observed bid/ask spread replaces the configured one. */
export function costsForBar(costs: CostModel, bar: { close: number; spread?: number }): CostModel {
  if (bar.spread == null || !(bar.spread >= 0) || !(bar.close > 0)) return costs;
  return { ...costs, spreadBps: (bar.spread / bar.close) * BPS };
}

/** Unrealized P&L in account currency, marked at the price the position could be closed at. */
export function unrealizedPnl(
  direction: Direction,
  entry: number,
  candlePrice: number,
  qty: number,
  spec: InstrumentSpec,
  costs: CostModel,
  conversion?: Conversion,
): number {
  const mark = sidePrice(candlePrice, exitSide(direction), costs);
  return toAccount(grossPnl(direction, entry, mark, qty, spec), mark, conversion);
}
