import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  CostModel,
  EngineEvent,
  EngineResult,
  EngineState,
  Execution,
  ExitReason,
  Order,
  Position,
} from "@/lib/engine/types";
import { round } from "@/lib/engine/math";
import type { Db } from "../db/client";
import {
  accountEquitySnapshots,
  executions,
  instruments,
  orders,
  paperAccounts,
  positions,
  simulationEvents,
  strategies,
  tradeJournal,
} from "../db/schema";

/** Drizzle transaction handle (same API as Db for our purposes). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

export type AccountRow = typeof paperAccounts.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type JournalRow = typeof tradeJournal.$inferSelect;

export class DuplicateExecutionError extends Error {
  constructor(id: string) {
    super(`Execution ${id} already recorded — refusing to apply it twice`);
    this.name = "DuplicateExecutionError";
  }
}

export function getAccount(db: Conn, id: string): AccountRow | undefined {
  return db.select().from(paperAccounts).where(eq(paperAccounts.id, id)).get();
}

export function accountCosts(account: AccountRow): CostModel {
  return account.costs as CostModel;
}

export function createAccount(
  db: Conn,
  a: { id: string; name: string; kind: "backtest" | "live"; startingBalance: number; costs: CostModel; riskPercent: number; currency?: string },
): AccountRow {
  db.insert(paperAccounts)
    .values({ ...a, balance: a.startingBalance, currency: a.currency ?? "USDT" })
    .run();
  return getAccount(db, a.id)!;
}

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  clientOrderId: r.clientOrderId,
  symbol: r.symbol,
  side: r.side as Order["side"],
  type: r.type as Order["type"],
  qty: r.qty,
  price: r.price,
  sl: r.sl,
  tp: r.tp,
  status: r.status as Order["status"],
  createdAt: r.createdAt,
  activeFrom: r.activeFrom,
  filledAt: r.filledAt,
  cancelledAt: r.cancelledAt,
  rejectReason: r.rejectReason,
});

export const toPosition = (r: PositionRow): Position => ({
  id: r.id,
  orderId: r.orderId,
  symbol: r.symbol,
  direction: r.direction as Position["direction"],
  qty: r.qty,
  entryPrice: r.entryPrice,
  entryTime: r.entryTime,
  sl: r.sl,
  tp: r.tp,
  initialSl: r.initialSl,
  initialTp: r.initialTp,
  initialRisk: r.initialRisk,
  status: r.status as Position["status"],
  exitPrice: r.exitPrice,
  exitTime: r.exitTime,
  exitReason: r.exitReason as ExitReason | null,
  entryFee: r.entryFee,
  exitFee: r.exitFee,
  slippageCost: r.slippageCost,
  financing: r.financing,
  margin: r.margin,
  grossPnl: r.grossPnl,
  netPnl: r.netPnl,
});

/** Engine state for an account, optionally limited to one symbol. */
export function loadEngineState(db: Conn, accountId: string, symbol?: string): EngineState {
  const account = getAccount(db, accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const oc = [eq(orders.accountId, accountId), eq(orders.status, "pending")];
  const pc = [eq(positions.accountId, accountId), eq(positions.status, "open")];
  if (symbol) {
    oc.push(eq(orders.symbol, symbol));
    pc.push(eq(positions.symbol, symbol));
  }
  return {
    balance: account.balance,
    orders: db.select().from(orders).where(and(...oc)).orderBy(asc(orders.createdAt)).all().map(toOrder),
    positions: db.select().from(positions).where(and(...pc)).orderBy(asc(positions.entryTime)).all().map(toPosition),
  };
}

export function findOrderByClientId(db: Conn, accountId: string, clientOrderId: string): OrderRow | undefined {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.accountId, accountId), eq(orders.clientOrderId, clientOrderId)))
    .get();
}

export interface PersistContext {
  accountId: string;
  sessionId: string | null;
  instrumentId: string;
  mode: "historical" | "live";
  /** Applied to newly created orders only. */
  orderMeta?: { strategyId: number | null; timeframe: string; entryNote?: string | null };
  dataSource: string;
  dataVersion: string;
  /** Currency of money columns (journal). */
  accountCurrency?: string;
  /** Instrument quote currency (journal). */
  quoteCurrency?: string | null;
  /** Unrealized P&L of the remaining positions (engine-computed) for equity snapshots. */
  unrealized?: number;
  /** Optional command record to append to the event log (for deterministic replay). */
  command?: Record<string, unknown> & { simTime: number };
}

/**
 * Persist an engine result atomically: orders, positions, executions (idempotent),
 * balance, event log, journal rows for closed positions, and equity snapshots.
 * Must be called inside a transaction.
 */
export function persistEngineResult(tx: Tx, ctx: PersistContext, result: EngineResult): void {
  const nowWall = Date.now();

  for (const o of result.orders) {
    const existing = tx.select({ id: orders.id }).from(orders).where(eq(orders.id, o.id)).get();
    if (existing) {
      tx.update(orders)
        .set({
          price: o.price,
          sl: o.sl,
          tp: o.tp,
          status: o.status,
          activeFrom: o.activeFrom,
          filledAt: o.filledAt,
          cancelledAt: o.cancelledAt,
          rejectReason: o.rejectReason,
          updatedAt: nowWall,
        })
        .where(eq(orders.id, o.id))
        .run();
    } else {
      if (!ctx.orderMeta) throw new Error("orderMeta is required to create orders");
      tx.insert(orders)
        .values({
          ...o,
          accountId: ctx.accountId,
          sessionId: ctx.sessionId,
          instrumentId: ctx.instrumentId,
          strategyId: ctx.orderMeta.strategyId,
          timeframe: ctx.orderMeta.timeframe,
          entryNote: ctx.orderMeta.entryNote ?? null,
          mode: ctx.mode,
        })
        .run();
    }
  }

  for (const p of result.positions) {
    const values = {
      id: p.id,
      accountId: ctx.accountId,
      sessionId: ctx.sessionId,
      orderId: p.orderId,
      instrumentId: ctx.instrumentId,
      symbol: p.symbol,
      direction: p.direction,
      qty: p.qty,
      entryPrice: p.entryPrice,
      entryTime: p.entryTime,
      sl: p.sl,
      tp: p.tp,
      initialSl: p.initialSl,
      initialTp: p.initialTp,
      initialRisk: p.initialRisk,
      status: p.status,
      exitPrice: p.exitPrice,
      exitTime: p.exitTime,
      exitReason: p.exitReason,
      entryFee: p.entryFee,
      exitFee: p.exitFee,
      slippageCost: p.slippageCost,
      financing: p.financing ?? 0,
      margin: p.margin ?? 0,
      grossPnl: p.grossPnl,
      netPnl: p.netPnl,
      updatedAt: nowWall,
    };
    const { id: _id, accountId: _a, orderId: _o, ...updatable } = values;
    void _id;
    void _a;
    void _o;
    tx.insert(positions).values(values).onConflictDoUpdate({ target: positions.id, set: updatable }).run();
  }

  for (const e of result.executions) insertExecution(tx, ctx.accountId, e);

  tx.update(paperAccounts)
    .set({ balance: result.state.balance, updatedAt: nowWall })
    .where(eq(paperAccounts.id, ctx.accountId))
    .run();

  const events: { type: string; simTime: number; payload: unknown }[] = [];
  if (ctx.command) events.push({ type: "command", simTime: ctx.command.simTime, payload: ctx.command });
  for (const ev of result.events) events.push({ type: ev.type, simTime: ev.time, payload: eventPayload(ev) });
  appendEvents(tx, ctx.accountId, ctx.sessionId, events);

  const closed = result.positions.filter((p) => p.status === "closed");
  for (const p of closed) createJournalEntry(tx, ctx, p);
  if (closed.length > 0) {
    const lastExit = Math.max(...closed.map((p) => p.exitTime ?? 0));
    snapshotEquity(tx, ctx.accountId, lastExit, result.state, "position_closed", ctx.unrealized ?? 0);
  }
}

function eventPayload(ev: EngineEvent): unknown {
  const { type: _t, time: _time, ...rest } = ev;
  void _t;
  void _time;
  return rest;
}

export function insertExecution(tx: Tx, accountId: string, e: Execution) {
  const res = tx
    .insert(executions)
    .values({ ...e, accountId, flags: e.flags })
    .onConflictDoNothing()
    .run();
  if (res.changes === 0) throw new DuplicateExecutionError(e.id);
}

export function appendEvents(
  tx: Tx,
  accountId: string,
  sessionId: string | null,
  events: { type: string; simTime: number; payload: unknown }[],
) {
  if (events.length === 0) return;
  const acc = tx
    .update(paperAccounts)
    .set({ eventSeq: sql`${paperAccounts.eventSeq} + ${events.length}` })
    .where(eq(paperAccounts.id, accountId))
    .returning({ seq: paperAccounts.eventSeq })
    .get()!;
  const start = acc.seq - events.length + 1;
  const wall = Date.now();
  tx.insert(simulationEvents)
    .values(events.map((e, i) => ({ accountId, sessionId, seq: start + i, type: e.type, simTime: e.simTime, wallTime: wall, payload: e.payload })))
    .run();
}

function createJournalEntry(tx: Tx, ctx: PersistContext, p: Position) {
  const order = tx.select().from(orders).where(eq(orders.id, p.orderId)).get();
  if (!order) throw new Error(`Order ${p.orderId} missing for journal entry`);
  const instrument = tx.select().from(instruments).where(eq(instruments.id, ctx.instrumentId)).get();
  const strategy = order.strategyId
    ? tx.select().from(strategies).where(eq(strategies.id, order.strategyId)).get()
    : undefined;
  const flags = new Set<string>();
  for (const e of tx.select({ flags: executions.flags }).from(executions).where(eq(executions.positionId, p.id)).all()) {
    for (const f of e.flags) flags.add(f);
  }
  const net = p.netPnl ?? 0;
  tx.insert(tradeJournal)
    .values({
      positionId: p.id,
      accountId: ctx.accountId,
      sessionId: ctx.sessionId,
      mode: order.mode,
      symbol: p.symbol,
      market: instrument?.market ?? "crypto",
      strategyId: order.strategyId,
      strategyName: strategy?.name ?? null,
      timeframe: order.timeframe,
      direction: p.direction,
      entryTime: p.entryTime,
      exitTime: p.exitTime!,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice!,
      qty: p.qty,
      initialSl: p.initialSl,
      initialTp: p.initialTp,
      finalSl: p.sl,
      finalTp: p.tp,
      grossPnl: p.grossPnl ?? 0,
      netPnl: net,
      fees: round(p.entryFee + p.exitFee, 8),
      slippageCost: p.slippageCost,
      financing: p.financing ?? 0,
      accountCurrency: ctx.accountCurrency ?? "USDT",
      quoteCurrency: ctx.quoteCurrency ?? instrument?.quoteAsset ?? null,
      initialRisk: p.initialRisk,
      rMultiple: p.initialRisk && p.initialRisk > 0 ? round(net / p.initialRisk, 4) : null,
      holdingMs: (p.exitTime ?? p.entryTime) - p.entryTime,
      entryReason: order.entryNote ? `${order.type}: ${order.entryNote}` : order.type,
      exitReason: p.exitReason ?? "manual",
      dataSource: ctx.dataSource,
      dataVersion: ctx.dataVersion,
      flags: [...flags],
    })
    .onConflictDoNothing()
    .run();
}

/** `unrealized` must come from the engine (contract size + currency conversion applied). */
export function snapshotEquity(tx: Conn, accountId: string, time: number, state: EngineState, reason: string, unrealized = 0) {
  const u = round(unrealized, 8);
  const usedMargin = round(state.positions.reduce((s, p) => s + (p.margin ?? 0), 0), 8);
  const values = { balance: state.balance, equity: round(state.balance + u, 8), unrealized: u, usedMargin, openPositions: state.positions.length };
  tx.insert(accountEquitySnapshots)
    .values({ accountId, time, reason, ...values })
    .onConflictDoUpdate({ target: [accountEquitySnapshots.accountId, accountEquitySnapshots.time, accountEquitySnapshots.reason], set: values })
    .run();
}

export function listOrders(db: Conn, accountId: string, opts: { status?: string[]; limit?: number; symbol?: string } = {}): OrderRow[] {
  const conds = [eq(orders.accountId, accountId)];
  if (opts.status?.length) conds.push(inArray(orders.status, opts.status));
  if (opts.symbol) conds.push(eq(orders.symbol, opts.symbol));
  return db
    .select()
    .from(orders)
    .where(and(...conds))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(opts.limit ?? 200)
    .all();
}

export function listPositions(db: Conn, accountId: string, opts: { status?: "open" | "closed"; limit?: number; symbol?: string } = {}): PositionRow[] {
  const conds = [eq(positions.accountId, accountId)];
  if (opts.status) conds.push(eq(positions.status, opts.status));
  if (opts.symbol) conds.push(eq(positions.symbol, opts.symbol));
  return db
    .select()
    .from(positions)
    .where(and(...conds))
    .orderBy(desc(positions.exitTime), desc(positions.entryTime))
    .limit(opts.limit ?? 200)
    .all();
}

/** Union of execution flags per position (for showing simulation uncertainty). */
export function flagsByPosition(db: Conn, positionIds: string[]): Record<string, string[]> {
  if (positionIds.length === 0) return {};
  const out: Record<string, string[]> = {};
  const rows = db.select({ positionId: executions.positionId, flags: executions.flags }).from(executions).where(inArray(executions.positionId, positionIds)).all();
  for (const r of rows) {
    if (!r.flags.length) continue;
    out[r.positionId] = [...new Set([...(out[r.positionId] ?? []), ...r.flags])];
  }
  return out;
}

export function listExecutions(db: Conn, accountId: string, limit = 500): ExecutionRow[] {
  return db.select().from(executions).where(eq(executions.accountId, accountId)).orderBy(asc(executions.time), asc(executions.id)).limit(limit).all();
}

export function listEvents(db: Conn, accountId: string, opts: { sessionId?: string; types?: string[]; limit?: number } = {}) {
  const conds = [eq(simulationEvents.accountId, accountId)];
  if (opts.sessionId) conds.push(eq(simulationEvents.sessionId, opts.sessionId));
  if (opts.types?.length) conds.push(inArray(simulationEvents.type, opts.types));
  return db
    .select()
    .from(simulationEvents)
    .where(and(...conds))
    .orderBy(asc(simulationEvents.seq))
    .limit(opts.limit ?? 100_000)
    .all();
}

/** Accounts that currently have live pending orders or open positions, by symbol. */
export function activeLiveSymbols(db: Conn): string[] {
  const rows = db
    .select({ symbol: orders.symbol })
    .from(orders)
    .innerJoin(paperAccounts, eq(paperAccounts.id, orders.accountId))
    .where(and(eq(paperAccounts.kind, "live"), eq(orders.status, "pending")))
    .all();
  const prow = db
    .select({ symbol: positions.symbol })
    .from(positions)
    .innerJoin(paperAccounts, eq(paperAccounts.id, positions.accountId))
    .where(and(eq(paperAccounts.kind, "live"), eq(positions.status, "open")))
    .all();
  return [...new Set([...rows, ...prow].map((r) => r.symbol))];
}

export function liveAccountsForSymbol(db: Conn, symbol: string): string[] {
  const a = db
    .select({ id: orders.accountId })
    .from(orders)
    .innerJoin(paperAccounts, eq(paperAccounts.id, orders.accountId))
    .where(and(eq(paperAccounts.kind, "live"), eq(orders.status, "pending"), eq(orders.symbol, symbol)))
    .all();
  const b = db
    .select({ id: positions.accountId })
    .from(positions)
    .innerJoin(paperAccounts, eq(paperAccounts.id, positions.accountId))
    .where(and(eq(paperAccounts.kind, "live"), eq(positions.status, "open"), eq(positions.symbol, symbol)))
    .all();
  return [...new Set([...a, ...b].map((r) => r.id))];
}
