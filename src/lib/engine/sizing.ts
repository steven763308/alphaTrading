import { fxRate, round, roundToStep } from "./math";
import type { Conversion, CostModel, InstrumentSpec, Side } from "./types";

export interface SizingInput {
  equity: number;
  riskPercent: number;
  entry: number;
  stop: number;
  side: Side;
  spec: InstrumentSpec;
  costs: CostModel;
  /** Quote→account conversion (defaults to identity). */
  conversion?: Conversion;
  /** Include estimated taker fees, slippage and commission on both legs. Default true. */
  includeCosts?: boolean;
}

export interface SizingResult {
  qty: number;
  /** Amount the trader intends to risk (equity * risk%), account currency. */
  riskBudget: number;
  /** Estimated loss if the stop is hit with the computed qty, including costs when enabled. */
  estimatedLoss: number;
  /** Account-currency risk per 1 quantity unit (e.g. per lot). */
  perUnitRisk: number;
  error: string | null;
}

/**
 * Fixed-fractional position sizing: qty = (equity * risk%) / per-unit risk,
 * rounded DOWN to the quantity step so the risk budget is never exceeded.
 * Per-unit risk is converted to account currency at the stop price (where the loss
 * would be realised), e.g. USDJPY risk in JPY ÷ price.
 */
export function riskPositionSize(input: SizingInput): SizingResult {
  const { equity, riskPercent, entry, stop, side, spec, costs } = input;
  const includeCosts = input.includeCosts ?? true;
  const riskBudget = round(equity * (riskPercent / 100), 8);

  const empty = (error: string): SizingResult => ({ qty: 0, riskBudget, estimatedLoss: 0, perUnitRisk: 0, error });

  if (!(equity > 0)) return empty("Equity must be positive");
  if (!(riskPercent > 0)) return empty("Risk % must be positive");
  if (!(entry > 0) || !(stop > 0)) return empty("Entry and stop must be positive");
  if (side === "buy" && stop >= entry) return empty("Stop loss must be below entry for a long");
  if (side === "sell" && stop <= entry) return empty("Stop loss must be above entry for a short");

  let perUnitQuote = Math.abs(entry - stop) * spec.contractSize;
  if (includeCosts) {
    const takerAndSlip = (costs.takerFeeBps + costs.slippageBps + costs.spreadBps / 2) / 10_000;
    perUnitQuote += (entry + stop) * takerAndSlip * spec.contractSize;
  }
  let perUnit = perUnitQuote * fxRate(stop, input.conversion);
  if (includeCosts) perUnit += 2 * (costs.commissionPerUnit ?? 0);
  if (!(perUnit > 0)) return empty("Cannot size: per-unit risk is zero (missing currency conversion?)");

  const qty = roundToStep(riskBudget / perUnit, spec.qtyStep, "down");
  if (qty < spec.minQty) {
    return { ...empty(`Calculated size ${qty} is below the minimum quantity ${spec.minQty}`), perUnitRisk: round(perUnit, 8) };
  }
  return { qty, riskBudget, estimatedLoss: round(qty * perUnit, 8), perUnitRisk: round(perUnit, 8), error: null };
}
