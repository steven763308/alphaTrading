import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { TradeRecord } from "@/lib/analytics/metrics";
import type { Db } from "../db/client";
import { executions, tradeJournal } from "../db/schema";
import type { JournalRow } from "./trading";

export interface JournalFilter {
  symbol?: string;
  market?: string;
  strategyId?: number | "none";
  timeframe?: string;
  mode?: "historical" | "live";
  sessionId?: string;
  from?: number;
  to?: number;
  direction?: "long" | "short";
}

function where(f: JournalFilter): SQL | undefined {
  const c: SQL[] = [];
  if (f.symbol) c.push(eq(tradeJournal.symbol, f.symbol.toUpperCase()));
  if (f.market) c.push(eq(tradeJournal.market, f.market));
  if (f.strategyId === "none") c.push(sql`${tradeJournal.strategyId} is null`);
  else if (f.strategyId != null) c.push(eq(tradeJournal.strategyId, f.strategyId));
  if (f.timeframe) c.push(eq(tradeJournal.timeframe, f.timeframe));
  if (f.mode) c.push(eq(tradeJournal.mode, f.mode));
  if (f.sessionId) c.push(eq(tradeJournal.sessionId, f.sessionId));
  if (f.direction) c.push(eq(tradeJournal.direction, f.direction));
  if (f.from != null) c.push(gte(tradeJournal.exitTime, f.from));
  if (f.to != null) c.push(lte(tradeJournal.exitTime, f.to));
  return c.length ? and(...c) : undefined;
}

export function listJournal(db: Db, f: JournalFilter, page = { limit: 100, offset: 0 }) {
  const w = where(f);
  const rows = db.select().from(tradeJournal).where(w).orderBy(desc(tradeJournal.exitTime), desc(tradeJournal.id)).limit(page.limit).offset(page.offset).all();
  const total = db.select({ n: sql<number>`count(*)` }).from(tradeJournal).where(w).get()?.n ?? 0;
  return { rows, total };
}

export function getJournalEntry(db: Db, id: number) {
  const row = db.select().from(tradeJournal).where(eq(tradeJournal.id, id)).get();
  if (!row) return undefined;
  const fills = db.select().from(executions).where(eq(executions.positionId, row.positionId)).all();
  return { ...row, executions: fills };
}

export interface JournalAnnotationUpdate {
  notes?: string | null;
  setupQuality?: number | null;
  ruleFollowed?: boolean | null;
  tags?: string[] | null;
  annotations?: { time: number; price: number; text: string }[] | null;
}

/**
 * Update ONLY the personal annotation columns. Execution facts (prices, times, P&L,
 * fees) are immutable and cannot be changed through this function by construction.
 */
export function updateJournalAnnotations(db: Db, id: number, u: JournalAnnotationUpdate): JournalRow | undefined {
  const set: Partial<typeof tradeJournal.$inferInsert> = { updatedAt: Date.now() };
  if (u.notes !== undefined) set.notes = u.notes;
  if (u.setupQuality !== undefined) set.setupQuality = u.setupQuality;
  if (u.ruleFollowed !== undefined) set.ruleFollowed = u.ruleFollowed;
  if (u.tags !== undefined) set.tags = u.tags;
  if (u.annotations !== undefined) set.annotations = u.annotations;
  db.update(tradeJournal).set(set).where(eq(tradeJournal.id, id)).run();
  return db.select().from(tradeJournal).where(eq(tradeJournal.id, id)).get();
}

export function journalTradeRecords(db: Db, f: JournalFilter): TradeRecord[] {
  return db
    .select()
    .from(tradeJournal)
    .where(where(f))
    .all()
    .map((r) => ({
      id: String(r.id),
      symbol: r.symbol,
      market: r.market,
      strategy: r.strategyName,
      timeframe: r.timeframe,
      direction: r.direction as "long" | "short",
      mode: r.mode as "historical" | "live",
      entryTime: r.entryTime,
      exitTime: r.exitTime,
      grossPnl: r.grossPnl,
      netPnl: r.netPnl,
      fees: r.fees,
      slippageCost: r.slippageCost,
      initialRisk: r.initialRisk,
      rMultiple: r.rMultiple,
    }));
}

export function journalFacets(db: Db) {
  const distinct = (col: typeof tradeJournal.symbol | typeof tradeJournal.timeframe | typeof tradeJournal.market) =>
    db.selectDistinct({ v: col }).from(tradeJournal).all().map((r) => r.v);
  return { symbols: distinct(tradeJournal.symbol), timeframes: distinct(tradeJournal.timeframe), markets: distinct(tradeJournal.market) };
}

const CSV_COLUMNS: [string, (r: JournalRow) => unknown][] = [
  ["id", (r) => r.id],
  ["mode", (r) => r.mode],
  ["market", (r) => r.market],
  ["symbol", (r) => r.symbol],
  ["strategy", (r) => r.strategyName ?? ""],
  ["timeframe", (r) => r.timeframe],
  ["direction", (r) => r.direction],
  ["entry_time_utc", (r) => new Date(r.entryTime).toISOString()],
  ["exit_time_utc", (r) => new Date(r.exitTime).toISOString()],
  ["entry_price", (r) => r.entryPrice],
  ["exit_price", (r) => r.exitPrice],
  ["qty", (r) => r.qty],
  ["initial_sl", (r) => r.initialSl ?? ""],
  ["initial_tp", (r) => r.initialTp ?? ""],
  ["final_sl", (r) => r.finalSl ?? ""],
  ["final_tp", (r) => r.finalTp ?? ""],
  ["gross_pnl", (r) => r.grossPnl],
  ["fees", (r) => r.fees],
  ["financing", (r) => r.financing],
  ["account_currency", (r) => r.accountCurrency],
  ["slippage_spread_cost", (r) => r.slippageCost],
  ["net_pnl", (r) => r.netPnl],
  ["initial_risk", (r) => r.initialRisk ?? ""],
  ["r_multiple", (r) => r.rMultiple ?? ""],
  ["holding_minutes", (r) => Math.round(r.holdingMs / 60_000)],
  ["entry_reason", (r) => r.entryReason],
  ["exit_reason", (r) => r.exitReason],
  ["setup_quality", (r) => r.setupQuality ?? ""],
  ["rule_followed", (r) => (r.ruleFollowed == null ? "" : r.ruleFollowed ? "yes" : "no")],
  ["tags", (r) => (r.tags ?? []).join("|")],
  ["flags", (r) => r.flags.join("|")],
  ["data_source", (r) => r.dataSource],
  ["data_version", (r) => r.dataVersion],
  ["notes", (r) => r.notes ?? ""],
];

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function journalCsv(db: Db, f: JournalFilter): string {
  const rows = db.select().from(tradeJournal).where(where(f)).orderBy(tradeJournal.exitTime).all();
  const lines = [CSV_COLUMNS.map(([h]) => h).join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(","));
  return lines.join("\r\n");
}
