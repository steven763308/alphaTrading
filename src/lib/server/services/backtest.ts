import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyCommand, mergeResults, type Command } from "@/lib/engine/commands";
import { emptyState, needsIntrabarResolution, processBar, unrealizedTotal, usedMargin } from "@/lib/engine/engine";
import type { Bar, Conversion, CostModel, EngineContext, EngineResult, EngineState } from "@/lib/engine/types";
import { EngineError } from "@/lib/engine/types";
import { normalizeCurrency } from "@/lib/market/catalog";
import { timeframeMs } from "@/lib/market/timeframes";
import type { Db } from "../db/client";
import { backtestSessions, instruments, marketDataDatasets, positions, strategies, tradeJournal } from "../db/schema";
import {
  checksumBars,
  countGaps,
  getCandleAt,
  getCandleRange,
  getCandlesAfter,
  getCandlesUpTo,
  getDataset,
  getInstrument,
  type InstrumentRow,
} from "../repo/market";
import {
  accountCosts,
  createAccount,
  findOrderByClientId,
  flagsByPosition,
  getAccount,
  listEvents,
  listExecutions,
  listOrders,
  listPositions,
  loadEngineState,
  persistEngineResult,
  snapshotEquity,
  type AccountRow,
  type PersistContext,
} from "../repo/trading";
import { getSettings } from "../repo/settings";
import { conversionPair, ensureInstrument, ensureProviderRange, getProvider, lowerTimeframeBars, rateAt, resolveProvider, specOf } from "./market-data";

export type SessionRow = typeof backtestSessions.$inferSelect;

export const MAX_SESSION_BARS = 250_000;
export const WARMUP_BARS = 300;
export const MAX_STEPS_PER_REQUEST = 500;

export class ConflictError extends Error {
  constructor(message = "Session changed concurrently; refresh and retry") {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface CreateSessionInput {
  name?: string;
  /** Provider id ("binance", "dukascopy", "oanda", "alpaca"), "auto", or "csv". */
  source: string;
  symbol?: string;
  datasetId?: number;
  timeframe: string;
  from: number;
  to: number;
  startingBalance: number;
  riskPercent?: number;
  strategyId?: number | null;
  costs?: CostModel;
  resolveLowerTf?: boolean;
  /** Leverage override (defaults to the instrument's assumption). */
  leverage?: number;
}

function getSession(db: Db, id: string): SessionRow {
  const s = db.select().from(backtestSessions).where(eq(backtestSessions.id, id)).get();
  if (!s) throw new NotFoundError(`Session ${id} not found`);
  return s;
}

/**
 * Engine context factory for a session. Cross-currency sessions look up the
 * conversion rate per bar from the stored conversion series (loaded in windows).
 */
function sessionContext(db: Db, s: SessionRow) {
  const instrument = getInstrument(db, s.instrumentId)!;
  const account = getAccount(db, s.accountId)!;
  const dataset = getDataset(db, s.datasetId)!;
  const step = timeframeMs(s.timeframe);
  // Sessions created before multi-market support (leverage null) keep legacy rules
  // (no margin/financing) so their replays stay deterministic.
  const legacy = s.leverage == null;
  const spec = legacy ? { ...specOf(instrument), leverage: undefined, financing: undefined } : specOf(instrument, s.leverage);
  const route = legacy ? { kind: "identity" as const } : conversionPair(instrument, account.currency);
  const base: EngineContext = {
    spec,
    costs: accountCosts(account),
    barMs: legacy ? undefined : step,
    margin: legacy ? undefined : { otherUsedMargin: 0, otherUnrealized: 0, stopOutLevelPct: account.stopOutLevel },
  };

  let window: { from: number; to: number; bars: Bar[] } | null = null;
  /** Context valid at simulation time `time` (rate = latest conversion close ≤ time). */
  const at = (time: number): EngineContext => {
    if (!route || route.kind === "identity") return { ...base, conversion: { kind: "identity" } };
    if (route.kind === "inverse") return { ...base, conversion: { kind: "inverse" } };
    if (!s.conversionDatasetId) throw new EngineError(`No ${route.pair} data for currency conversion`);
    if (!window || time < window.from || time > window.to) {
      const from = time - 7 * 86_400_000;
      const to = time + Math.max(30 * step, 3 * 86_400_000);
      window = { from, to, bars: getCandleRange(db, s.conversionDatasetId, from, to) };
    }
    const rate = rateAt(window.bars, time, s.conversionInvert);
    if (rate == null) throw new EngineError(`No ${route.pair} price available at ${new Date(time).toISOString()} for currency conversion`);
    const conversion: Conversion = { kind: "rate", rate };
    return { ...base, conversion };
  };
  return { instrument, account, dataset, base, at, route, step };
}

function persistCtx(s: SessionRow, instrument: InstrumentRow, account: AccountRow): Omit<PersistContext, "orderMeta"> {
  return {
    accountId: s.accountId,
    sessionId: s.id,
    instrumentId: instrument.id,
    mode: "historical",
    dataSource: `${instrument.sourceId}:${instrument.symbol}:${s.timeframe} dataset#${s.datasetId}`,
    dataVersion: `v${s.dataVersion} sha256:${s.dataChecksum.slice(0, 12)}`,
    accountCurrency: account.currency,
    quoteCurrency: instrument.quoteAsset,
  };
}

/** Find (or download) a conversion-pair dataset on the same timeframe. */
async function conversionDataset(db: Db, instrument: InstrumentRow, pair: string, timeframe: string, from: number, to: number): Promise<number> {
  const existing = db
    .select({ id: marketDataDatasets.id, sourceId: marketDataDatasets.sourceId })
    .from(marketDataDatasets)
    .innerJoin(instruments, eq(instruments.id, marketDataDatasets.instrumentId))
    .where(and(eq(instruments.symbol, pair), eq(marketDataDatasets.timeframe, timeframe)))
    .all();
  if (instrument.sourceId !== "csv" && getProvider(instrument.sourceId).supports(pair)) {
    const pairInst = await ensureInstrument(db, instrument.sourceId, pair);
    return (await ensureProviderRange(db, pairInst, timeframe, from, to)).datasetId;
  }
  const pick = existing.find((d) => d.sourceId === instrument.sourceId) ?? existing[0];
  if (!pick) throw new EngineError(`Converting ${instrument.quoteAsset} P&L needs ${pair} ${timeframe} data — import a ${pair} CSV for the same period first`);
  return pick.id;
}

export async function createSession(db: Db, input: CreateSessionInput) {
  const step = timeframeMs(input.timeframe);
  if (!(input.to > input.from)) throw new EngineError("End date must be after start date");
  if (!(input.startingBalance > 0)) throw new EngineError("Starting balance must be positive");
  const expectedBars = Math.floor((input.to - input.from) / step) + 1;
  if (expectedBars > MAX_SESSION_BARS)
    throw new EngineError(`Range has ~${expectedBars} bars; the limit is ${MAX_SESSION_BARS}. Use a higher timeframe or shorter range.`);

  let instrument: InstrumentRow;
  let datasetId: number;
  let providerId: string | null = null;
  if (input.source !== "csv") {
    if (!input.symbol) throw new EngineError("Symbol is required");
    const avail = resolveProvider(input.symbol, "historical", input.source === "auto" ? undefined : input.source);
    if (!avail.provider) throw new EngineError(avail.reason ?? `No historical data for ${input.symbol}`);
    if (input.source !== "auto" && avail.provider !== input.source) {
      throw new EngineError(`${input.source} cannot provide ${input.symbol}: ${avail.reason ?? "not supported"}`);
    }
    providerId = avail.provider;
    const caps = getProvider(providerId).capabilities();
    if (!caps.timeframes.includes(input.timeframe)) throw new EngineError(`${caps.name} supports ${caps.timeframes.join(", ")}`);
    instrument = await ensureInstrument(db, providerId, input.symbol);
    datasetId = (await ensureProviderRange(db, instrument, input.timeframe, input.from - WARMUP_BARS * step, input.to)).datasetId;
  } else {
    if (!input.datasetId) throw new EngineError("Choose an imported CSV dataset");
    const ds = getDataset(db, input.datasetId);
    if (!ds) throw new EngineError("Dataset not found");
    if (ds.timeframe !== input.timeframe) throw new EngineError(`Dataset timeframe is ${ds.timeframe}`);
    instrument = getInstrument(db, ds.instrumentId)!;
    datasetId = ds.id;
  }

  const bars = getCandleRange(db, datasetId, input.from, input.to);
  if (bars.length < 2) throw new EngineError("Not enough historical candles in the selected range");
  const warm = getCandlesUpTo(db, datasetId, input.from - 1, 1);
  const initialCursor = warm.length ? warm[0].time : bars[0].time;
  const dataset = getDataset(db, datasetId)!;
  const settings = getSettings(db);

  const assetClass = instrument.market;
  const currency = normalizeCurrency(instrument.quoteAsset ?? "") === "USD" && assetClass === "crypto" ? "USDT" : "USD";
  const route = conversionPair(instrument, currency);
  if (!route) throw new EngineError(`No currency conversion route from ${instrument.quoteAsset} to ${currency}`);
  let conversionDatasetId: number | null = null;
  if (route.kind === "rate" && route.pair) {
    conversionDatasetId = await conversionDataset(db, instrument, route.pair, input.timeframe, input.from - WARMUP_BARS * step, input.to);
  }

  const id = randomUUID();
  const strategyName = input.strategyId ? db.select().from(strategies).where(eq(strategies.id, input.strategyId)).get()?.name : undefined;
  const name =
    input.name?.trim() ||
    `${instrument.symbol} ${input.timeframe} ${new Date(input.from).toISOString().slice(0, 10)}${strategyName ? ` · ${strategyName}` : ""}`;
  const costs = input.costs ?? settings.costsByAssetClass[assetClass] ?? settings.costs;

  db.transaction((tx) => {
    createAccount(tx, {
      id: `bt-${id}`,
      name,
      kind: "backtest",
      startingBalance: input.startingBalance,
      costs,
      riskPercent: input.riskPercent ?? settings.riskPercent,
      currency,
    });
    tx.insert(backtestSessions)
      .values({
        id,
        accountId: `bt-${id}`,
        name,
        instrumentId: instrument.id,
        datasetId,
        timeframe: input.timeframe,
        startTime: input.from,
        endTime: input.to,
        initialCursorTime: initialCursor,
        cursorTime: initialCursor,
        dataVersion: dataset.version,
        dataChecksum: checksumBars(bars),
        gapCount: countGaps(bars, step),
        strategyId: input.strategyId ?? null,
        // Per-bar 1m downloads are fast on Binance only; elsewhere default to the conservative rule.
        resolveLowerTf: input.resolveLowerTf ?? providerId === "binance",
        leverage: input.leverage ?? instrument.leverage,
        conversionDatasetId,
        conversionInvert: route.invert ?? false,
      })
      .run();
  });
  return getSessionView(db, id);
}

export function listSessions(db: Db) {
  return db
    .select({
      session: backtestSessions,
      symbol: instruments.symbol,
      market: instruments.market,
      // Explicit qualifiers: Drizzle omits table names for single-table selects, which
      // would make this correlated subquery compare trade_journal columns with themselves.
      trades: sql<number>`(select count(*) from trade_journal tj where tj.session_id = "backtest_sessions"."id")`,
      netPnl: sql<number>`(select coalesce(sum(tj.net_pnl), 0) from trade_journal tj where tj.session_id = "backtest_sessions"."id")`,
    })
    .from(backtestSessions)
    .innerJoin(instruments, eq(instruments.id, backtestSessions.instrumentId))
    .orderBy(desc(backtestSessions.updatedAt))
    .all();
}

export function getSessionView(db: Db, id: string) {
  const s = getSession(db, id);
  const { instrument, account, dataset, at, route, base } = sessionContext(db, s);
  const cursorBar = getCandleAt(db, s.datasetId, s.cursorTime);
  const price = cursorBar?.close ?? 0;
  const state = loadEngineState(db, s.accountId);
  let ctx: EngineContext = base;
  let conversionError: string | null = null;
  try {
    ctx = at(s.cursorTime);
  } catch (e) {
    conversionError = e instanceof Error ? e.message : String(e);
  }
  const unrealized = conversionError ? 0 : unrealizedTotal(state, { [instrument.symbol]: price }, ctx);
  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(sql`candles`)
    .where(sql`dataset_id = ${s.datasetId} and time >= ${s.startTime} and time <= ${s.endTime}`)
    .get()!.n;
  const done = db
    .select({ n: sql<number>`count(*)` })
    .from(sql`candles`)
    .where(sql`dataset_id = ${s.datasetId} and time >= ${s.startTime} and time <= ${s.cursorTime}`)
    .get()!.n;
  const warnings: string[] = [];
  if (s.gapCount > 0) warnings.push(`${s.gapCount} missing bar(s) in this range (market closed, outage or incomplete data); gaps are not filled.`);
  if (dataset.version !== s.dataVersion) warnings.push("Dataset has received new candles since this session was created (replay range is unaffected; checksum verifies it).");
  if (dataset.priceBasis === "mid") warnings.push("Prices are MID (bid/ask average) with the observed spread applied per bar.");
  if (route?.kind === "rate") warnings.push(`P&L converted from ${instrument.quoteAsset} to ${account.currency} using ${route.pair} closes.`);
  if (route?.kind === "inverse") warnings.push(`P&L converted from ${instrument.quoteAsset} to ${account.currency} at the instrument's own price.`);
  if (conversionError) warnings.push(conversionError);
  if (normalizeCurrency(account.currency) !== account.currency) warnings.push(`${account.currency} is treated as USD 1:1.`);

  const closed = listPositions(db, s.accountId, { status: "closed", limit: 100 });
  const used = usedMargin(state);
  const equity = account.balance + unrealized;
  return {
    session: s,
    account: { ...account, equity, unrealized, usedMargin: used, freeMargin: equity - used },
    instrument,
    conversion: ctx.conversion ?? { kind: "identity" as const },
    leverage: ctx.spec.leverage ?? null,
    costs: ctx.costs,
    cursorBar,
    price,
    simTime: s.cursorTime + timeframeMs(s.timeframe),
    progress: { done, total },
    pendingOrders: listOrders(db, s.accountId, { status: ["pending"] }),
    recentOrders: listOrders(db, s.accountId, { limit: 50 }),
    openPositions: listPositions(db, s.accountId, { status: "open" }),
    closedPositions: closed,
    flagsByPosition: flagsByPosition(db, closed.map((p) => p.id)),
    priceBasis: dataset.priceBasis,
    warnings,
  };
}

/** Candles visible to the trader: never later than the replay cursor (future masking). */
export function getVisibleCandles(db: Db, id: string, opts: { before?: number; limit?: number }) {
  const s = getSession(db, id);
  const upTo = Math.min(s.cursorTime, opts.before != null ? opts.before - 1 : Infinity);
  return getCandlesUpTo(db, s.datasetId, upTo, Math.min(opts.limit ?? 1000, 5000));
}

type Sc = ReturnType<typeof sessionContext>;

async function stepBars(db: Db, s: SessionRow, sc: Sc, state: EngineState, bars: Bar[]) {
  const results: EngineResult[] = [];
  let lastCtx: EngineContext = sc.base;
  for (const bar of bars) {
    // Conversion rate as of the bar's close.
    const ctx = sc.at(bar.time + sc.step - 1);
    lastCtx = ctx;
    let subBars: Bar[] | null = null;
    if (s.resolveLowerTf && needsIntrabarResolution(state, bar, ctx)) {
      subBars = await lowerTimeframeBars(db, sc.instrument, bar, s.timeframe);
    }
    const r = processBar(state, bar, ctx, subBars ? { subBars } : {});
    state = r.state;
    if (r.executions.length || r.orders.length || r.positions.length) results.push(r);
  }
  return { state, results, lastCtx };
}

/**
 * Reveal and process the next `steps` bars. `revision` must match the session's
 * current revision; a stale or duplicated request is a no-op that returns the
 * current state, so double-clicks and retries can never advance twice.
 */
export async function advanceSession(db: Db, id: string, input: { steps: number; revision: number }) {
  const s = getSession(db, id);
  if (s.revision !== input.revision) {
    return { applied: false as const, reason: "stale_revision", bars: [] as Bar[], view: getSessionView(db, id) };
  }
  if (s.status === "completed") return { applied: false as const, reason: "completed", bars: [] as Bar[], view: getSessionView(db, id) };

  const sc = sessionContext(db, s);
  const steps = Math.max(1, Math.min(input.steps, MAX_STEPS_PER_REQUEST));
  const bars = getCandlesAfter(db, s.datasetId, s.cursorTime, s.endTime, steps);
  const startState = loadEngineState(db, s.accountId);
  const { state, results, lastCtx } = await stepBars(db, s, sc, startState, bars);
  const merged = mergeResults(results, state);
  const lastBar = bars[bars.length - 1];
  const more = lastBar ? getCandlesAfter(db, s.datasetId, lastBar.time, s.endTime, 1).length > 0 : false;
  const unrealized = lastBar ? unrealizedTotal(state, { [sc.instrument.symbol]: lastBar.close }, lastCtx) : 0;

  db.transaction((tx) => {
    const fresh = tx.select({ revision: backtestSessions.revision }).from(backtestSessions).where(eq(backtestSessions.id, id)).get();
    if (!fresh || fresh.revision !== s.revision) throw new ConflictError();
    persistEngineResult(tx, { ...persistCtx(s, sc.instrument, sc.account), unrealized }, merged);
    tx.update(backtestSessions)
      .set({
        cursorTime: lastBar ? lastBar.time : s.cursorTime,
        revision: s.revision + 1,
        status: more ? "active" : "completed",
        updatedAt: Date.now(),
      })
      .where(eq(backtestSessions.id, id))
      .run();
    if (!more && lastBar) snapshotEquity(tx, s.accountId, lastBar.time + sc.step, state, "session_end", unrealized);
  });

  return { applied: true as const, bars, executions: merged.executions, view: getSessionView(db, id) };
}

export type SessionCommandInput =
  | (Omit<Extract<Command, { kind: "place" }>, "orderId"> & { strategyId?: number | null; entryNote?: string | null })
  | Exclude<Command, { kind: "place" }>;

/** Apply a trading command at the current cursor. Placing is idempotent per clientOrderId. */
export function sessionCommand(db: Db, id: string, input: SessionCommandInput) {
  const s = getSession(db, id);
  const sc = sessionContext(db, s);
  const cursorBar = getCandleAt(db, s.datasetId, s.cursorTime);
  if (!cursorBar) throw new EngineError("No price at the replay cursor");

  if (input.kind === "place") {
    const dup = findOrderByClientId(db, s.accountId, input.clientOrderId);
    if (dup) return { duplicate: true, orderId: dup.id, view: getSessionView(db, id) };
  }
  const market = { price: cursorBar.close, time: s.cursorTime + sc.step };
  const ctx = sc.at(market.time - 1);
  const cmd: Command = input.kind === "place" ? { ...stripMeta(input), orderId: randomUUID() } : input;
  const state = loadEngineState(db, s.accountId);
  const result = applyCommand(state, cmd, market, ctx);
  const unrealized = unrealizedTotal(result.state, { [sc.instrument.symbol]: cursorBar.close }, ctx);

  db.transaction((tx) => {
    persistEngineResult(
      tx,
      {
        ...persistCtx(s, sc.instrument, sc.account),
        orderMeta: {
          strategyId: input.kind === "place" ? (input.strategyId ?? s.strategyId) : s.strategyId,
          timeframe: s.timeframe,
          entryNote: input.kind === "place" ? input.entryNote : null,
        },
        unrealized,
        command: { ...cmd, simTime: market.time, cursorTime: s.cursorTime },
      },
      result,
    );
    tx.update(backtestSessions)
      .set({ revision: sql`${backtestSessions.revision} + 1`, updatedAt: Date.now() })
      .where(eq(backtestSessions.id, id))
      .run();
  });
  const rejected = result.orders.find((o) => o.status === "rejected");
  return { duplicate: false, rejected: rejected?.rejectReason ?? null, view: getSessionView(db, id) };
}

function stripMeta(input: Extract<SessionCommandInput, { kind: "place" }>): Omit<Extract<Command, { kind: "place" }>, "orderId"> {
  const { strategyId: _s, entryNote: _n, ...rest } = input;
  void _s;
  void _n;
  return rest;
}

/** resolveLowerTf, leverage and conversion are fixed at creation for deterministic replay. */
export function updateSessionSettings(db: Db, id: string, changes: { name?: string; strategyId?: number | null }) {
  getSession(db, id);
  db.update(backtestSessions)
    .set({ ...changes, updatedAt: Date.now() })
    .where(eq(backtestSessions.id, id))
    .run();
  return getSessionView(db, id);
}

export function deleteSession(db: Db, id: string) {
  const s = getSession(db, id);
  db.transaction((tx) => {
    tx.delete(tradeJournal).where(eq(tradeJournal.sessionId, id)).run();
    tx.run(sql`delete from executions where account_id = ${s.accountId}`);
    tx.delete(positions).where(eq(positions.accountId, s.accountId)).run();
    tx.run(sql`delete from orders where account_id = ${s.accountId}`);
    tx.delete(backtestSessions).where(eq(backtestSessions.id, id)).run();
    tx.run(sql`delete from paper_accounts where id = ${s.accountId}`);
  });
}

/**
 * Deterministic replay check: rebuild the session from its starting balance, the
 * logged commands and the stored candles, then compare every execution and the
 * final balance with what was recorded.
 */
export async function verifyReplay(db: Db, id: string) {
  const s = getSession(db, id);
  const sc = sessionContext(db, s);
  const commands = listEvents(db, s.accountId, { sessionId: id, types: ["command"] }).map((e) => e.payload as Command & { cursorTime: number });
  const allBars = getCandleRange(db, s.datasetId, s.initialCursorTime, s.cursorTime);
  const checksum = checksumBars(getCandleRange(db, s.datasetId, s.startTime, s.endTime));

  let state = emptyState(sc.account.startingBalance);
  const executions: EngineResult["executions"] = [];
  let ci = 0;
  const applyAt = (cursor: number, price: number) => {
    while (ci < commands.length && commands[ci].cursorTime === cursor) {
      const { cursorTime: _c, simTime: _t, ...cmd } = commands[ci] as Command & { cursorTime: number; simTime?: number };
      void _c;
      void _t;
      try {
        const time = cursor + sc.step;
        const r = applyCommand(state, cmd as Command, { price, time }, sc.at(time - 1));
        state = r.state;
        executions.push(...r.executions);
      } catch {
        // A command that threw originally was never logged; a throw here is a mismatch
        // that will surface in the execution comparison.
      }
      ci++;
    }
  };

  for (let i = 0; i < allBars.length; i++) {
    const bar = allBars[i];
    if (i > 0) {
      const { state: next, results } = await stepBars(db, s, sc, state, [bar]);
      state = next;
      for (const r of results) executions.push(...r.executions);
    }
    applyAt(bar.time, bar.close);
  }

  const recorded = listExecutions(db, s.accountId, 1_000_000);
  const key = (e: { id: string; price: number; qty: number; fee: number; time: number; reason: string }) => `${e.id}|${e.price}|${e.qty}|${e.fee}|${e.time}|${e.reason}`;
  // Order ids are logged inside commands, so execution ids are reproducible.
  const a = new Set(recorded.map(key));
  const b = new Set(executions.map(key));
  const missing = [...a].filter((k) => !b.has(k));
  const extra = [...b].filter((k) => !a.has(k));
  const recordedBalance = getAccount(db, s.accountId)!.balance;
  return {
    ok: missing.length === 0 && extra.length === 0 && Math.abs(recordedBalance - state.balance) < 1e-6 && checksum === s.dataChecksum,
    checksumMatches: checksum === s.dataChecksum,
    recordedExecutions: recorded.length,
    replayedExecutions: executions.length,
    recordedBalance,
    replayedBalance: state.balance,
    mismatches: { missing, extra },
    commandsReplayed: ci,
    commandsLogged: commands.length,
  };
}
