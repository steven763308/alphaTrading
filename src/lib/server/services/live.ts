import { randomUUID } from "node:crypto";
import { applyCommand, type Command } from "@/lib/engine/commands";
import { unrealizedPnl } from "@/lib/engine/math";
import { usedMargin } from "@/lib/engine/engine";
import { EngineError } from "@/lib/engine/types";
import { marketStatus } from "@/lib/market/calendars";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { LIVE_ACCOUNT_ID } from "../db/seed";
import { buildLiveContext, liveConversion, liveCosts } from "../live/context";
import { LiveFeed } from "../live/feed";
import { getInstrument, instrumentId } from "../repo/market";
import { getSettings } from "../repo/settings";
import { findOrderByClientId, flagsByPosition, getAccount, listOrders, listPositions, loadEngineState, persistEngineResult, toPosition } from "../repo/trading";
import type { SessionCommandInput } from "./backtest";
import { conversionPair, ensureInstrument, getProvider, resolveProvider, specOf } from "./market-data";

const g = globalThis as unknown as { __tradelabFeed?: LiveFeed };

export function getLiveFeed(): LiveFeed {
  if (!g.__tradelabFeed) {
    g.__tradelabFeed = new LiveFeed({
      getDb,
      getProvider,
      staleAfterMs: () => getSettings(getDb()).staleAfterSeconds * 1000,
      reconcileLookbackMs: () => getSettings(getDb()).reconcileLookbackHours * 3_600_000,
      log: (m) => console.log(m),
    });
    g.__tradelabFeed.start();
  }
  return g.__tradelabFeed;
}

/** Resolve the live instrument for a symbol, or throw a clear "unavailable" error. */
export async function liveInstrument(db: Db, symbol: string, provider?: string) {
  const avail = resolveProvider(symbol, "live", provider);
  if (!avail.provider) throw new EngineError(avail.reason ?? `Live data unavailable for ${symbol}`);
  return ensureInstrument(db, avail.provider, symbol);
}

export type LiveCommandInput = SessionCommandInput & { symbol: string; timeframe: string; provider?: string };

export async function liveCommand(db: Db, input: LiveCommandInput, feed: LiveFeed = getLiveFeed()) {
  const instrument = await liveInstrument(db, input.symbol, input.provider);

  if (input.kind === "place") {
    const dup = findOrderByClientId(db, LIVE_ACCOUNT_ID, input.clientOrderId);
    if (dup) return { duplicate: true, rejected: null, orderId: dup.id };
  }

  // Cross pairs need the conversion pair streamed too.
  const account = getAccount(db, LIVE_ACCOUNT_ID)!;
  const route = conversionPair(instrument, account.currency);
  if (route?.kind === "rate" && route.pair) {
    const pair = await ensureInstrument(db, instrument.sourceId, route.pair);
    feed.ensureStreamed(pair.id);
  }

  const snap = feed.snapshot(instrument.id);
  // Cancelling never needs a price, so it stays possible while the feed is down.
  if (input.kind !== "cancel" && !snap.ok) {
    throw new EngineError(`Cannot execute: ${snap.reason}. No price is assumed while live data is unavailable.`);
  }
  const price = snap.price ?? 0;
  // Pending orders become active strictly after the last price we have seen, so
  // they can never fill on price action from before they existed.
  const time = Math.max(feed.now(), (snap.eventTime ?? 0) + 1);
  const built = buildLiveContext(db, LIVE_ACCOUNT_ID, instrument, feed.prices(), time);
  if ("error" in built && input.kind !== "cancel") throw new EngineError(built.error);
  const ctx = "ctx" in built ? built.ctx : { spec: specOf(instrument), costs: liveCosts(account, instrument, db) };

  let cmd: Command;
  let orderMeta: { strategyId: number | null; timeframe: string; entryNote?: string | null } = { strategyId: null, timeframe: input.timeframe };
  if (input.kind === "place") {
    const { strategyId, entryNote, symbol: _s, timeframe: _tf, provider: _p, ...rest } = input;
    void _s;
    void _tf;
    void _p;
    cmd = { ...rest, orderId: randomUUID() };
    orderMeta = { strategyId: strategyId ?? null, timeframe: input.timeframe, entryNote };
  } else {
    const { symbol: _s, timeframe: _tf, provider: _p, ...rest } = input;
    void _s;
    void _tf;
    void _p;
    cmd = rest as Command;
  }

  const result = applyCommand(loadEngineState(db, LIVE_ACCOUNT_ID, instrument.symbol), cmd, { price, time }, ctx);
  db.transaction((tx) =>
    persistEngineResult(
      tx,
      {
        accountId: LIVE_ACCOUNT_ID,
        sessionId: null,
        instrumentId: instrument.id,
        mode: "live",
        orderMeta,
        dataSource: `${instrument.sourceId}-stream`,
        dataVersion: "live-stream",
        accountCurrency: account.currency,
        quoteCurrency: instrument.quoteAsset,
        command: { ...cmd, simTime: time, instrument: instrument.id, price },
      },
      result,
    ),
  );
  feed.refreshActive();
  const rejected = result.orders.find((o) => o.status === "rejected");
  return { duplicate: false, rejected: rejected?.rejectReason ?? null };
}

/** Live availability for a symbol, for the UI (never substitutes data). */
export function liveAvailability(symbol: string) {
  const avail = resolveProvider(symbol, "live");
  return { ...avail, capabilities: avail.provider ? getProvider(avail.provider).capabilities() : null };
}

export function getLiveState(db: Db, feed: LiveFeed = getLiveFeed()) {
  const account = getAccount(db, LIVE_ACCOUNT_ID)!;
  const state = loadEngineState(db, LIVE_ACCOUNT_ID);
  const prices = feed.prices();
  let unrealized = 0;
  const unrealizedByPosition: Record<string, number> = {};
  const openRows = listPositions(db, LIVE_ACCOUNT_ID, { status: "open" });
  for (const row of openRows) {
    const inst = getInstrument(db, row.instrumentId);
    const price = prices[row.instrumentId];
    if (!inst || !(price > 0)) continue;
    const conv = liveConversion(account, inst, prices);
    if ("error" in conv) continue;
    const p = toPosition(row);
    const u = unrealizedPnl(p.direction, p.entryPrice, price, p.qty, specOf(inst), liveCosts(account, inst, db), conv.conversion);
    unrealizedByPosition[row.id] = u;
    unrealized += u;
  }
  const closed = listPositions(db, LIVE_ACCOUNT_ID, { status: "closed", limit: 100 });
  const used = usedMargin(state);
  const equity = account.balance + unrealized;
  return {
    account: { ...account, equity, unrealized, usedMargin: used, freeMargin: equity - used },
    costs: account.costs,
    pendingOrders: listOrders(db, LIVE_ACCOUNT_ID, { status: ["pending"] }),
    recentOrders: listOrders(db, LIVE_ACCOUNT_ID, { limit: 50 }),
    openPositions: openRows,
    closedPositions: closed,
    flagsByPosition: flagsByPosition(db, closed.map((p) => p.id)),
    prices,
    unrealizedByPosition,
    feeds: feed.allStatus(),
    notice:
      "Local-first mode: live paper orders are only monitored while this app is running. Automatic execution while your computer is off would need an always-on service. After downtime, missed periods are reconciled from 1m candles and resulting fills are flagged as approximate.",
  };
}

/** Instrument view for the live UI: spec, costs, session status, availability. */
export async function liveInstrumentInfo(db: Db, symbol: string) {
  const avail = liveAvailability(symbol);
  if (!avail.provider) return { available: false as const, reason: avail.reason, candidates: avail.candidates };
  const inst = await ensureInstrument(db, avail.provider, symbol);
  const account = getAccount(db, LIVE_ACCOUNT_ID)!;
  return {
    available: true as const,
    instrument: inst,
    instrumentId: instrumentId(inst.sourceId, inst.symbol),
    costs: liveCosts(account, inst, db),
    session: marketStatus(inst.calendar, Date.now()),
    capabilities: avail.capabilities,
    accountCurrency: account.currency,
  };
}
