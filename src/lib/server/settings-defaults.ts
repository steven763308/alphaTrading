import type { CostModel } from "@/lib/engine/types";

export interface AppSettings {
  /** IANA time zone used for display and day-of-week analytics. */
  timeZone: string;
  riskPercent: number;
  /** Default costs for crypto (kept for backwards compatibility). */
  costs: CostModel;
  /** Default costs per asset class for new sessions/accounts. */
  costsByAssetClass: Record<string, CostModel>;
  /** Live data older than this is considered stale; market orders are rejected. */
  staleAfterSeconds: number;
  /** Max lookback when reconciling missed live data after an outage. */
  reconcileLookbackHours: number;
  defaultSymbol: string;
  defaultTimeframe: string;
}

/**
 * Cost defaults are typical retail assumptions, not any broker's schedule:
 * - crypto: Binance spot VIP0 0.10% maker/taker, tight BTC spread.
 * - forex: raw-spread style, $3.50 per lot per side commission; the observed
 *   Dukascopy/OANDA spread replaces spreadBps when available.
 * - metals: spread-only pricing (no commission).
 * - stocks: commission-free broker, ~2 bp spread.
 */
export const DEFAULT_COSTS_BY_CLASS: Record<string, CostModel> = {
  crypto: { makerFeeBps: 10, takerFeeBps: 10, spreadBps: 1, slippageBps: 2 },
  forex: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 0.8, slippageBps: 0.2, commissionPerUnit: 3.5 },
  metals: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 1.5, slippageBps: 0.5, commissionPerUnit: 0 },
  stocks: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 2, slippageBps: 1, commissionPerUnit: 0 },
  indices: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 1, slippageBps: 0.5, commissionPerUnit: 0 },
  futures: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 1, slippageBps: 0.5, commissionPerUnit: 2 },
  commodities: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 3, slippageBps: 1, commissionPerUnit: 0 },
  custom: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 2, slippageBps: 1, commissionPerUnit: 0 },
};

export const DEFAULT_SETTINGS: AppSettings = {
  timeZone: "UTC",
  riskPercent: 1,
  costs: DEFAULT_COSTS_BY_CLASS.crypto,
  costsByAssetClass: DEFAULT_COSTS_BY_CLASS,
  staleAfterSeconds: 20,
  reconcileLookbackHours: 72,
  defaultSymbol: "BTCUSDT",
  defaultTimeframe: "15m",
};
