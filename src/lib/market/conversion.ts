import type { Conversion } from "@/lib/engine/types";
import { CATALOG, normalizeCurrency } from "./catalog";

export interface ConversionRoute {
  kind: Conversion["kind"];
  /** For crosses: the pair whose price converts quote → account currency. */
  pair?: string;
  /** True when that pair's price must be inverted (e.g. USDJPY for JPY → USD). */
  invert?: boolean;
}

/**
 * How to convert an instrument's quote currency into the account currency.
 * Pure (shared by server and browser). Null when no route exists.
 */
export function conversionPair(instrument: { symbol: string; baseAsset: string | null; quoteAsset: string | null }, accountCurrency: string): ConversionRoute | null {
  const acct = normalizeCurrency(accountCurrency);
  const quote = normalizeCurrency(instrument.quoteAsset ?? "");
  const base = normalizeCurrency(instrument.baseAsset ?? "");
  if (!quote || quote === acct) return { kind: "identity" };
  if (base === acct) return { kind: "inverse" };
  const direct = CATALOG.find((c) => c.symbol === `${quote}${acct}`);
  if (direct) return { kind: "rate", pair: direct.symbol, invert: false };
  const inverse = CATALOG.find((c) => c.symbol === `${acct}${quote}`);
  if (inverse) return { kind: "rate", pair: inverse.symbol, invert: true };
  return null;
}

/** Resolve a route to an engine Conversion given a price lookup for the pair. */
export function resolveConversion(route: ConversionRoute | null, pairPrice: (symbol: string) => number | undefined): Conversion | null {
  if (!route) return null;
  if (route.kind !== "rate") return { kind: route.kind };
  const p = pairPrice(route.pair!);
  if (!(p && p > 0)) return null;
  return { kind: "rate", rate: route.invert ? 1 / p : p };
}
