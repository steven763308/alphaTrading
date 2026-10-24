import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCatalog } from "@/lib/market/catalog";
import { openDb, type Db } from "@/lib/server/db/client";
import { LIVE_ACCOUNT_ID } from "@/lib/server/db/seed";
import { LiveFeed, type FeedEvent } from "@/lib/server/live/feed";
import { listJournal } from "@/lib/server/repo/journal";
import { upsertInstrument } from "@/lib/server/repo/market";
import { listPositions } from "@/lib/server/repo/trading";
import { setProvider } from "@/lib/server/services/market-data";
import { liveCommand } from "@/lib/server/services/live";
import { FakeProvider } from "./fake-provider";

const MON = Date.UTC(2024, 1, 5, 10, 0, 0); // Monday 05:00 New York — FX open
const SAT = Date.UTC(2024, 1, 10, 12, 0, 0); // Saturday — FX closed

let db: Db;
let provider: FakeProvider;
let feed: LiveFeed;
let clock: number;
let events: FeedEvent[];

function setup(start: number) {
  db = openDb(":memory:").db;
  const c = findCatalog("EURUSD")!;
  upsertInstrument(db, "oanda", { symbol: "EURUSD", baseAsset: "EUR", quoteAsset: "USD", tickSize: c.tickSize, qtyStep: c.qtyStep, minQty: c.minQty, contractSize: c.contractSize }, "forex", {
    calendar: "fx",
    leverage: 30,
    unit: "lot",
    providerSymbol: "EUR_USD",
    financing: { longAnnualPct: 0, shortAnnualPct: 0, tripleDay: null },
  });
  provider = new FakeProvider("oanda", "quote");
  setProvider("oanda", provider);
  clock = start;
  feed = new LiveFeed({ getDb: () => db, getProvider: () => provider, now: () => clock, timers: false });
  feed.start();
  events = [];
  feed.watch("oanda:EURUSD", "1m", (e) => events.push(e));
  provider.handlers!.onStatus("connected");
}

const place = (extra: Record<string, unknown>) =>
  liveCommand(db, { kind: "place", clientOrderId: `c-${Math.random()}`, side: "buy", type: "market", qty: 1, symbol: "EURUSD", timeframe: "1m", ...extra } as never, feed);

afterEach(() => feed.stop());

describe("quote-driven live paper trading (FX)", () => {
  beforeEach(async () => {
    setup(MON);
    await new Promise((r) => setImmediate(r));
  });

  it("fills at the real ask, stops out on quotes, and journals in USD with commission", async () => {
    provider.quote({ symbol: "EUR_USD", bid: 1.0800, ask: 1.0801, time: clock });
    expect(feed.snapshot("oanda:EURUSD").ok).toBe(true);
    await place({ sl: 1.0780 });
    const pos = listPositions(db, LIVE_ACCOUNT_ID, { status: "open" })[0];
    // Live snapshot is the mid (1.08005); the configured FX spread/slippage then apply.
    expect(pos.entryPrice).toBeGreaterThan(1.08005);
    expect(pos.margin).toBeCloseTo((pos.entryPrice * 100_000) / 30, 4);

    clock += 1000;
    provider.quote({ symbol: "EUR_USD", bid: 1.0790, ask: 1.0791, time: clock });
    expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "open" })).toHaveLength(1);
    clock += 1000;
    provider.quote({ symbol: "EUR_USD", bid: 1.0775, ask: 1.0776, time: clock }); // through the stop
    const closed = listPositions(db, LIVE_ACCOUNT_ID, { status: "closed" });
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe("stop_loss");
    const j = listJournal(db, { mode: "live" }).rows[0];
    expect(j.market).toBe("forex");
    expect(j.dataSource).toBe("oanda-stream:quotes");
    expect(j.fees).toBeCloseTo(7, 6); // $3.50 per lot per side
    expect(j.grossPnl).toBeCloseTo((j.exitPrice - j.entryPrice) * 100_000, 4);
  });

  it("builds chart candles from quotes", () => {
    provider.quote({ symbol: "EUR_USD", bid: 1.08, ask: 1.0801, time: clock });
    clock += 5000;
    provider.quote({ symbol: "EUR_USD", bid: 1.0805, ask: 1.0806, time: clock });
    const candles = events.filter((e) => e.type === "candle");
    expect(candles.length).toBeGreaterThan(0);
    const last = candles[candles.length - 1] as Extract<FeedEvent, { type: "candle" }>;
    expect(last.bar.high).toBeCloseTo(1.08055, 8);
    expect(last.bar.low).toBeCloseTo(1.08005, 8);
  });
});

describe("market sessions in live mode", () => {
  beforeEach(async () => {
    setup(SAT);
    await new Promise((r) => setImmediate(r));
  });

  it("refuses market orders while FX is closed (weekend) but accepts pending orders", async () => {
    provider.quote({ symbol: "EUR_USD", bid: 1.08, ask: 1.0801, time: clock });
    const r = await place({});
    expect(r.rejected).toMatch(/Market is closed/);
    const pending = await place({ type: "limit", price: 1.07 });
    expect(pending.rejected).toBeNull();
    // A quote through the limit on the weekend must not execute.
    clock += 1000;
    provider.quote({ symbol: "EUR_USD", bid: 1.0690, ask: 1.0691, time: clock });
    expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "open" })).toHaveLength(0);
  });
});
