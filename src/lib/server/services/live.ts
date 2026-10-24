import { randomUUID } from "node:crypto";
import { applyCommand, type Command } from "@/lib/engine/commands";
import { unrealizedTotal } from "@/lib/engine/engine";
import { EngineError, type EngineContext } from "@/lib/engine/types";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { LIVE_ACCOUNT_ID } from "../db/seed";
import { LiveFeed } from "../live/feed";
import { getInstrument, instrumentId } from "../repo/market";
import { getSettings } from "../repo/settings";
import {
  accountCosts,
  findOrderByClientId,
  flagsByPosition,
  getAccount,
  listOrders,
  listPositions,
  loadEngineState,
  persistEngineResult,
} from "../repo/trading";
import type { SessionCommandInput } from "./backtest";
import { ensureInstrument, getProvider, specOf } from "./market-data";

const g = globalThis as unknown as { __tradelabFeed?: LiveFeed };

export function getLiveFeed(): LiveFeed {
  if (!g.__tradelabFeed) {
    g.__tradelabFeed = new LiveFeed({
      getDb,
      provider: getProvider("binance"),
      staleAfterMs: () => getSettings(getDb()).staleAfterSeconds * 1000,
      reconcileLookbackMs: () => getSettings(getDb()).reconcileLookbackHours * 3_600_000,
      log: (m) => console.log(m),
    });
    g.__tradelabFeed.start();
  }
  return g.__tradelabFeed;
}

export type LiveCommandInput = SessionCommandInput & { symbol: string; timeframe: string };

export async function liveCommand(db: Db, input: LiveCommandInput, feed: LiveFeed = getLiveFeed()) {
  const symbol = input.symbol.toUpperCase();
  const instrument = await ensureInstrument(db, "binance", symbol);
  const account = getAccount(db, LIVE_ACCOUNT_ID)!;
  const ctx: EngineContext = { spec: specOf(instrument), costs: accountCosts(account) };

  if (input.kind === "place") {
    const dup = findOrderByClientId(db, LIVE_ACCOUNT_ID, input.clientOrderId);
    if (dup) return { duplicate: true, rejected: null, orderId: dup.id };
  }

  const snap = feed.snapshot(symbol);
  // Cancelling never needs a price, so it stays possible while the feed is down.
  if (input.kind !== "cancel" && !snap.ok) {
    throw new EngineError(`Cannot execute: ${snap.reason}. No price is assumed while live data is unavailable.`);
  }
  const price = snap.price ?? 0;
  // Pending orders become active strictly after the last price we have seen, so
  // they can never fill on price action from before they existed.
  const time = Math.max(feed.now(), (snap.eventTime ?? 0) + 1);

  let cmd: Command;
  let orderMeta: { strategyId: number | null; timeframe: string; entryNote?: string | null } = {
    strategyId: null,
    timeframe: input.timeframe,
  };
  if (input.kind === "place") {
    const { strategyId, entryNote, symbol: _s, timeframe: _tf, ...rest } = input;
    void _s;
    void _tf;
    cmd = { ...rest, orderId: randomUUID() };
    orderMeta = { strategyId: strategyId ?? null, timeframe: input.timeframe, entryNote };
  } else {
    const { symbol: _s, timeframe: _tf, ...rest } = input;
    void _s;
    void _tf;
    cmd = rest as Command;
  }

  const result = applyCommand(loadEngineState(db, LIVE_ACCOUNT_ID, symbol), cmd, { price, time }, ctx);
  db.transaction((tx) =>
    persistEngineResult(
      tx,
      {
        accountId: LIVE_ACCOUNT_ID,
        sessionId: null,
        instrumentId: instrument.id,
        mode: "live",
        orderMeta,
        dataSource: "binance-ws:kline_1m",
        dataVersion: "live-stream",
        markPrice: price,
        command: { ...cmd, simTime: time, symbol, price },
      },
      result,
    ),
  );
  feed.refreshActive();
  const rejected = result.orders.find((o) => o.status === "rejected");
  return { duplicate: false, rejected: rejected?.rejectReason ?? null };
}

export function getLiveState(db: Db, feed: LiveFeed = getLiveFeed()) {
  const account = getAccount(db, LIVE_ACCOUNT_ID)!;
  const state = loadEngineState(db, LIVE_ACCOUNT_ID);
  const prices = feed.prices();
  const unrealized = unrealizedTotal(state, prices, (symbol) => {
    const inst = getInstrument(db, instrumentId("binance", symbol));
    return {
      spec: inst ? specOf(inst) : { symbol, tickSize: 0.01, qtyStep: 0.00001, minQty: 0, contractSize: 1 },
      costs: accountCosts(account),
    };
  });
  const closed = listPositions(db, LIVE_ACCOUNT_ID, { status: "closed", limit: 100 });
  return {
    account: { ...account, equity: account.balance + unrealized, unrealized },
    costs: accountCosts(account),
    pendingOrders: listOrders(db, LIVE_ACCOUNT_ID, { status: ["pending"] }),
    recentOrders: listOrders(db, LIVE_ACCOUNT_ID, { limit: 50 }),
    openPositions: listPositions(db, LIVE_ACCOUNT_ID, { status: "open" }),
    closedPositions: closed,
    flagsByPosition: flagsByPosition(db, closed.map((p) => p.id)),
    feed: feed.statusEvent(),
    notice:
      "Local-first mode: live paper orders are only monitored while this app is running. After downtime, missed periods are reconciled from 1m candles and any resulting fills are flagged as approximate.",
  };
}
