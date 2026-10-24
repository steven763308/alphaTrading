import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import type { Bar } from "@/lib/engine/types";
import type { SymbolInfo } from "@/lib/market/provider";
import type { Db } from "../db/client";
import { candles, datasetCoverage, instruments, marketDataDatasets } from "../db/schema";

export type InstrumentRow = typeof instruments.$inferSelect;
export type DatasetRow = typeof marketDataDatasets.$inferSelect;

export const LIVE_CACHE_LABEL = "live-cache";

export function instrumentId(sourceId: string, symbol: string) {
  return `${sourceId}:${symbol.toUpperCase()}`;
}

export interface InstrumentExtras {
  displayName?: string | null;
  unit?: string;
  leverage?: number;
  calendar?: string;
  timeZone?: string;
  financing?: { longAnnualPct: number; shortAnnualPct: number; tripleDay: number | null } | null;
  providerSymbol?: string | null;
}

export function upsertInstrument(db: Db, sourceId: string, info: SymbolInfo, market = "crypto", extras: InstrumentExtras = {}): InstrumentRow {
  const id = instrumentId(sourceId, info.symbol);
  const spec = {
    tickSize: info.tickSize,
    qtyStep: info.qtyStep,
    minQty: info.minQty,
    contractSize: info.contractSize,
    market,
    ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)),
  };
  db.insert(instruments)
    .values({ id, sourceId, symbol: info.symbol.toUpperCase(), baseAsset: info.baseAsset, quoteAsset: info.quoteAsset, ...spec })
    .onConflictDoUpdate({ target: instruments.id, set: spec })
    .run();
  return db.select().from(instruments).where(eq(instruments.id, id)).get()!;
}

// ---------------------------------------------------------------- coverage

/** Record that [from, to] was fetched (merged with overlapping/adjacent ranges). */
export function addCoverage(db: Db, datasetId: number, from: number, to: number, stepMs: number) {
  if (to < from) return;
  db.transaction((tx) => {
    const rows = tx.select().from(datasetCoverage).where(eq(datasetCoverage.datasetId, datasetId)).all();
    let lo = from;
    let hi = to;
    const merged: number[] = [];
    for (const r of rows) {
      if (r.toTime + stepMs >= lo && r.fromTime - stepMs <= hi) {
        lo = Math.min(lo, r.fromTime);
        hi = Math.max(hi, r.toTime);
        merged.push(r.id);
      }
    }
    for (const mid of merged) tx.delete(datasetCoverage).where(eq(datasetCoverage.id, mid)).run();
    tx.insert(datasetCoverage).values({ datasetId, fromTime: lo, toTime: hi }).run();
  });
}

/** Sub-ranges of [from, to] (bar open times) not yet fetched AND without stored candles. */
export function uncoveredRanges(db: Db, datasetId: number, from: number, to: number, stepMs: number): [number, number][] {
  const covered = db
    .select()
    .from(datasetCoverage)
    .where(and(eq(datasetCoverage.datasetId, datasetId), lte(datasetCoverage.fromTime, to), gte(datasetCoverage.toTime, from)))
    .orderBy(asc(datasetCoverage.fromTime))
    .all();
  const out: [number, number][] = [];
  for (const [a, b] of missingRanges(db, datasetId, from, to, stepMs)) {
    let cursor = a;
    for (const c of covered) {
      if (c.toTime < cursor || c.fromTime > b) continue;
      if (c.fromTime > cursor) out.push([cursor, Math.min(b, c.fromTime - stepMs)]);
      cursor = Math.max(cursor, c.toTime + stepMs);
      if (cursor > b) break;
    }
    if (cursor <= b) out.push([cursor, b]);
  }
  return out.filter(([x, y]) => y >= x);
}

export function setDatasetMeta(db: Db, datasetId: number, priceBasis: string, meta: Record<string, unknown>) {
  db.update(marketDataDatasets).set({ priceBasis, meta }).where(eq(marketDataDatasets.id, datasetId)).run();
}

export function getInstrument(db: Db, id: string): InstrumentRow | undefined {
  return db.select().from(instruments).where(eq(instruments.id, id)).get();
}

export function listInstruments(db: Db): InstrumentRow[] {
  return db.select().from(instruments).orderBy(asc(instruments.symbol)).all();
}

export function getOrCreateDataset(db: Db, sourceId: string, instrument: string, timeframe: string, label: string): DatasetRow {
  db.insert(marketDataDatasets)
    .values({ sourceId, instrumentId: instrument, timeframe, label })
    .onConflictDoNothing()
    .run();
  return db
    .select()
    .from(marketDataDatasets)
    .where(
      and(
        eq(marketDataDatasets.sourceId, sourceId),
        eq(marketDataDatasets.instrumentId, instrument),
        eq(marketDataDatasets.timeframe, timeframe),
        eq(marketDataDatasets.label, label),
      ),
    )
    .get()!;
}

export function getDataset(db: Db, id: number): DatasetRow | undefined {
  return db.select().from(marketDataDatasets).where(eq(marketDataDatasets.id, id)).get();
}

export function listDatasets(db: Db) {
  return db
    .select({ dataset: marketDataDatasets, symbol: instruments.symbol })
    .from(marketDataDatasets)
    .innerJoin(instruments, eq(instruments.id, marketDataDatasets.instrumentId))
    .orderBy(desc(marketDataDatasets.updatedAt))
    .all();
}

/**
 * Append candles. Existing (dataset, time) rows are never overwritten, so closed
 * historical candles are immutable once stored. Bumps the dataset version when
 * anything new was written. Returns the number of inserted rows.
 */
export function insertCandles(db: Db, datasetId: number, bars: Bar[]): number {
  if (bars.length === 0) return 0;
  let inserted = 0;
  db.transaction((tx) => {
    const CHUNK = 500;
    for (let i = 0; i < bars.length; i += CHUNK) {
      const chunk = bars
        .slice(i, i + CHUNK)
        .map((b) => ({ datasetId, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, spread: b.spread ?? null }));
      inserted += tx.insert(candles).values(chunk).onConflictDoNothing().run().changes;
    }
    if (inserted > 0) {
      const stats = tx
        .select({ first: sql<number>`min(${candles.time})`, last: sql<number>`max(${candles.time})`, n: sql<number>`count(*)` })
        .from(candles)
        .where(eq(candles.datasetId, datasetId))
        .get()!;
      tx.update(marketDataDatasets)
        .set({
          firstTime: stats.first,
          lastTime: stats.last,
          candleCount: stats.n,
          version: sql`${marketDataDatasets.version} + 1`,
          updatedAt: Date.now(),
        })
        .where(eq(marketDataDatasets.id, datasetId))
        .run();
    }
  });
  return inserted;
}

const toBar = (r: typeof candles.$inferSelect): Bar => ({
  time: r.time,
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
  ...(r.spread != null ? { spread: r.spread } : {}),
});

export function getCandleRange(db: Db, datasetId: number, from: number, to: number): Bar[] {
  return db
    .select()
    .from(candles)
    .where(and(eq(candles.datasetId, datasetId), gte(candles.time, from), lte(candles.time, to)))
    .orderBy(asc(candles.time))
    .all()
    .map(toBar);
}

/** The last `limit` candles with time <= `upTo`, ascending. */
export function getCandlesUpTo(db: Db, datasetId: number, upTo: number, limit: number, from?: number): Bar[] {
  const conds = [eq(candles.datasetId, datasetId), lte(candles.time, upTo)];
  if (from != null) conds.push(gte(candles.time, from));
  return db
    .select()
    .from(candles)
    .where(and(...conds))
    .orderBy(desc(candles.time))
    .limit(limit)
    .all()
    .map(toBar)
    .reverse();
}

export function getCandleAt(db: Db, datasetId: number, time: number): Bar | undefined {
  const r = db
    .select()
    .from(candles)
    .where(and(eq(candles.datasetId, datasetId), eq(candles.time, time)))
    .get();
  return r ? toBar(r) : undefined;
}

/** Next `limit` candles strictly after `after` and at or before `upTo`. */
export function getCandlesAfter(db: Db, datasetId: number, after: number, upTo: number, limit: number): Bar[] {
  return db
    .select()
    .from(candles)
    .where(and(eq(candles.datasetId, datasetId), gt(candles.time, after), lte(candles.time, upTo)))
    .orderBy(asc(candles.time))
    .limit(limit)
    .all()
    .map(toBar);
}

export function countCandles(db: Db, datasetId: number, from: number, to: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(candles)
      .where(and(eq(candles.datasetId, datasetId), gte(candles.time, from), lte(candles.time, to)))
      .get()?.n ?? 0
  );
}

/** Contiguous missing intervals [from, to] (bar open times) in the stored data. */
export function missingRanges(db: Db, datasetId: number, from: number, to: number, stepMs: number): [number, number][] {
  const expected = Math.floor((to - from) / stepMs) + 1;
  if (countCandles(db, datasetId, from, to) >= expected) return [];
  const times = db
    .select({ t: candles.time })
    .from(candles)
    .where(and(eq(candles.datasetId, datasetId), gte(candles.time, from), lte(candles.time, to)))
    .orderBy(asc(candles.time))
    .all()
    .map((r) => r.t);
  const out: [number, number][] = [];
  let expect = from;
  for (const t of times) {
    if (t > expect) out.push([expect, t - stepMs]);
    expect = t + stepMs;
  }
  if (expect <= to) out.push([expect, to]);
  return out;
}

/** Count bars missing between consecutive stored candles (exchange outages etc.). */
export function countGaps(bars: Bar[], stepMs: number): number {
  let gaps = 0;
  for (let i = 1; i < bars.length; i++) {
    const missing = Math.round((bars[i].time - bars[i - 1].time) / stepMs) - 1;
    if (missing > 0) gaps += missing;
  }
  return gaps;
}

/** Content hash of the candles a session replays, so data changes are detectable. */
export function checksumBars(bars: Bar[]): string {
  const h = createHash("sha256");
  for (const b of bars) h.update(`${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}${b.spread != null ? `,s${b.spread}` : ""};`);
  return h.digest("hex");
}
