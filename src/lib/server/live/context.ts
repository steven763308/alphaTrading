import { unrealizedPnl } from "@/lib/engine/math";
import type { Conversion, EngineContext } from "@/lib/engine/types";
import { marketStatus } from "@/lib/market/calendars";
import type { Db } from "../db/client";
import { getInstrument, instrumentId, type InstrumentRow } from "../repo/market";
import { getSettings } from "../repo/settings";
import { accountCosts, getAccount, toPosition, type AccountRow } from "../repo/trading";
import { positions as positionsTable } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { conversionPair, specOf } from "../services/market-data";

/** Live prices keyed by instrument id ("oanda:EURUSD"). */
export type PriceMap = Record<string, number>;

/**
 * Costs for a live trade: the live account's own cost model applies to crypto (its
 * historical default); other asset classes use the per-class defaults in Settings.
 */
export function liveCosts(account: AccountRow, instrument: InstrumentRow, db: Db) {
  if (instrument.market === "crypto") return accountCosts(account);
  return getSettings(db).costsByAssetClass[instrument.market] ?? accountCosts(account);
}

export function liveConversion(account: AccountRow, instrument: InstrumentRow, prices: PriceMap): { conversion: Conversion } | { error: string } {
  const route = conversionPair(instrument, account.currency);
  if (!route) return { error: `No conversion route from ${instrument.quoteAsset} to ${account.currency}` };
  if (route.kind !== "rate") return { conversion: { kind: route.kind } };
  const pairId = instrumentId(instrument.sourceId, route.pair!);
  const p = prices[pairId];
  if (!(p > 0)) return { error: `Needs a live ${route.pair} price to convert ${instrument.quoteAsset} P&L — open ${route.pair} on the same provider` };
  return { conversion: { kind: "rate", rate: route.invert ? 1 / p : p } };
}

/** Margin used and unrealized P&L of the account's positions on OTHER instruments. */
export function otherExposure(db: Db, accountId: string, excludeInstrumentId: string, prices: PriceMap) {
  const rows = db
    .select()
    .from(positionsTable)
    .where(and(eq(positionsTable.accountId, accountId), eq(positionsTable.status, "open")))
    .all()
    .filter((r) => r.instrumentId !== excludeInstrumentId);
  let usedMargin = 0;
  let unrealized = 0;
  for (const r of rows) {
    usedMargin += r.margin;
    const inst = getInstrument(db, r.instrumentId);
    const price = prices[r.instrumentId];
    if (!inst || !(price > 0)) continue;
    const account = getAccount(db, accountId)!;
    const conv = liveConversion(account, inst, prices);
    if ("error" in conv) continue;
    const p = toPosition(r);
    unrealized += unrealizedPnl(p.direction, p.entryPrice, price, p.qty, specOf(inst), liveCosts(account, inst, db), conv.conversion);
  }
  return { usedMargin, unrealized };
}

/** Full engine context for a live account/instrument at `time`, or a reason it can't run. */
export function buildLiveContext(db: Db, accountId: string, instrument: InstrumentRow, prices: PriceMap, time: number): { ctx: EngineContext } | { error: string } {
  const account = getAccount(db, accountId);
  if (!account) return { error: "Account not found" };
  const conv = liveConversion(account, instrument, prices);
  if ("error" in conv) return conv;
  const other = otherExposure(db, accountId, instrument.id, prices);
  const status = marketStatus(instrument.calendar, time);
  return {
    ctx: {
      spec: specOf(instrument),
      costs: liveCosts(account, instrument, db),
      conversion: conv.conversion,
      marketOpen: status.open,
      margin: { otherUsedMargin: other.usedMargin, otherUnrealized: other.unrealized, stopOutLevelPct: account.stopOutLevel },
    },
  };
}

