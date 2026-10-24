import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar } from "@/lib/engine/types";
import { openDb, type Db } from "@/lib/server/db/client";
import { paperAccounts } from "@/lib/server/db/schema";
import { LIVE_ACCOUNT_ID } from "@/lib/server/db/seed";
import { LiveFeed, type FeedEvent } from "@/lib/server/live/feed";
import { listJournal } from "@/lib/server/repo/journal";
import { upsertInstrument } from "@/lib/server/repo/market";
import { listEvents, listPositions } from "@/lib/server/repo/trading";
import { liveCommand } from "@/lib/server/services/live";
import { FakeProvider } from "./fake-provider";
import { BTC } from "./helpers";

const T0 = Date.UTC(2024, 2, 4, 8, 0, 0);
const MIN = 60_000;

let db: Db;
let provider: FakeProvider;
let feed: LiveFeed;
let clock: number;
let events: FeedEvent[];

const bar = (time: number, o: number, h: number, l: number, c: number): Bar => ({ time, open: o, high: h, low: l, close: c, volume: 1 });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(async () => {
  db = openDb(":memory:").db;
  db.update(paperAccounts)
    .set({ costs: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 0, slippageBps: 0 } })
    .where(eq(paperAccounts.id, LIVE_ACCOUNT_ID))
    .run();
  // Legacy-style spec (no leverage) so these tests isolate feed behaviour from margin rules.
  upsertInstrument(db, "binance", { ...BTC, baseAsset: "BTC", quoteAsset: "USDT" }, "crypto", { leverage: 100 });
  provider = new FakeProvider();
  clock = T0;
  feed = new LiveFeed({ getDb: () => db, getProvider: () => provider, now: () => clock, timers: false, staleAfterMs: () => 20_000 });
  feed.start();
  events = [];
  feed.watch("binance:BTCUSDT", "1m", (e) => events.push(e));
  provider.handlers!.onStatus("connected");
  await flush();
});

afterEach(() => {
  feed.stop();
  vi.useRealTimers();
});

/** Emit a 1m kline update at the current clock. */
function tick(b: Bar, closed = false) {
  provider.emit({ bar: b, eventTime: clock, closed });
}

const place = (extra: Record<string, unknown> = {}) =>
  liveCommand(
    db,
    { kind: "place", clientOrderId: `c-${Math.random()}`, side: "buy", type: "market", qty: 1, symbol: "BTCUSDT", timeframe: "1m", ...extra } as never,
    feed,
  );

describe("live paper trading", () => {
  it("streams prices and executes stop losses from kline updates", async () => {
    tick(bar(T0, 100, 100.2, 99.8, 100));
    expect(feed.snapshot("binance:BTCUSDT").ok).toBe(true);
    await place({ sl: 99, tp: 102 });
    expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "open" })).toHaveLength(1);

    clock += 2_000;
    tick(bar(T0, 100, 100.3, 99.8, 100.1)); // nothing touched
    expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "open" })).toHaveLength(1);

    clock += 2_000;
    tick(bar(T0, 100, 100.3, 98.9, 99.1)); // new low 98.9 ≤ SL 99
    const closed = listPositions(db, LIVE_ACCOUNT_ID, { status: "closed" });
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe("stop_loss");
    expect(closed[0].exitPrice).toBe(99);
    const j = listJournal(db, { mode: "live" }).rows[0];
    expect(j.dataSource).toBe("binance-ws:kline_1m");
    expect(j.flags).toEqual([]);
    expect(events.some((e) => e.type === "account")).toBe(true);
  });

  it("does not treat an unchanged kline high/low as a new touch", async () => {
    // The minute already traded to 101.5 before the position existed.
    tick(bar(T0, 100, 101.5, 99.8, 100));
    await place({ tp: 101 });
    clock += 2_000;
    tick(bar(T0, 100, 101.5, 99.8, 100.4)); // high unchanged → only 100→100.4 is certain
    expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "open" })).toHaveLength(1);
    clock += 2_000;
    tick(bar(T0, 100, 101.6, 99.8, 101.2)); // new high → TP reached after entry
    clock += 2_000;
    tick(bar(T0, 100, 101.6, 99.8, 101.2));
    expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "closed" })[0]?.exitReason).toBe("take_profit");
  });

  it("marks the feed stale and refuses market execution without fresh prices", async () => {
    tick(bar(T0, 100, 100.2, 99.8, 100));
    clock += 25_000;
    feed.tick();
    expect(feed.statusEvent("binance").status).toBe("stale");
    expect(feed.snapshot("binance:BTCUSDT").ok).toBe(false);
    await expect(place()).rejects.toThrow(/stale|No price is assumed/);
  });

  it("still allows cancelling pending orders while disconnected", async () => {
    tick(bar(T0, 100, 100.2, 99.8, 100));
    await place({ type: "limit", price: 95 });
    provider.handlers!.onStatus("disconnected", "test");
    const order = (await import("@/lib/server/repo/trading")).listOrders(db, LIVE_ACCOUNT_ID, { status: ["pending"] })[0];
    await liveCommand(db, { kind: "cancel", orderId: order.id, symbol: "BTCUSDT", timeframe: "1m" }, feed);
    await expect(place()).rejects.toThrow(/disconnected/);
  });

  it("reconciles missed data after a disconnect and flags the resulting fills", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    tick(bar(T0, 100, 100.2, 99.8, 100));
    await place({ sl: 95, tp: 110 });

    provider.handlers!.onStatus("disconnected", "network");
    expect(feed.statusEvent("binance").status).toBe("disconnected");

    // While offline the market dropped through the stop at 08:05.
    provider.data["1m"] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) =>
      m === 5 ? bar(T0 + m * MIN, 99, 99.5, 94, 96) : bar(T0 + m * MIN, 99.5, 100, 99, 99.5),
    );
    provider.data["1m:recent"] = [bar(T0 + 9 * MIN, 99.5, 100, 99, 99.5), bar(T0 + 10 * MIN, 97, 97.5, 96.8, 97)];
    clock = T0 + 10 * MIN + 30_000;

    vi.advanceTimersByTime(1_000); // reconnect backoff
    expect(provider.opened).toBe(2);
    provider.handlers!.onStatus("connected");
    await vi.waitFor(() => expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "closed" })).toHaveLength(1));

    const pos = listPositions(db, LIVE_ACCOUNT_ID, { status: "closed" })[0];
    expect(pos.exitReason).toBe("stop_loss");
    expect(pos.exitPrice).toBe(95);
    expect(pos.exitTime).toBe(T0 + 5 * MIN);
    const j = listJournal(db, { mode: "live" }).rows[0];
    expect(j.flags).toContain("reconciled_gap");
    expect(j.dataVersion).toBe("reconciled-after-gap");
    const logged = listEvents(db, LIVE_ACCOUNT_ID, { types: ["feed_reconciled"] });
    expect(logged).toHaveLength(1);
    expect(events.some((e) => e.type === "notice" && e.level === "warn")).toBe(true);
    // Not tradable until a fresh streamed price arrives after reconnecting.
    expect(feed.snapshot("binance:BTCUSDT").ok).toBe(false);
    tick(bar(T0 + 10 * MIN, 97, 97.6, 96.8, 97.2));
    expect(feed.snapshot("binance:BTCUSDT").ok).toBe(true);
  });

  it("stays unreconciled (and processes nothing) if missed data cannot be fetched", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    tick(bar(T0, 100, 100.2, 99.8, 100));
    await place({ sl: 95 });
    provider.handlers!.onStatus("disconnected");
    provider.failRest = true;
    clock = T0 + 5 * MIN;
    vi.advanceTimersByTime(1_000);
    provider.handlers!.onStatus("connected");
    await flush();
    await flush();
    const snap = feed.snapshot("binance:BTCUSDT");
    expect(snap.ok).toBe(false);
    // A stream update through the stop must NOT be applied over an unreconciled gap.
    tick(bar(T0 + 5 * MIN, 96, 96, 90, 91));
    expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "open" })).toHaveLength(1);
    expect(feed.snapshot("binance:BTCUSDT").reason).toMatch(/Reconciling/);
  });

  it("falls back to REST when whole minutes are missing from the stream", async () => {
    tick(bar(T0, 100, 100.2, 99.8, 100));
    await place({ sl: 95 });
    provider.data["1m"] = [bar(T0, 100, 100.2, 99.8, 100), bar(T0 + MIN, 100, 100, 94.5, 95.5), bar(T0 + 2 * MIN, 95.5, 96, 95, 95.8)];
    provider.data["1m:recent"] = [bar(T0 + 3 * MIN, 95.8, 96, 95.6, 95.9)];
    clock = T0 + 3 * MIN + 5_000;
    tick(bar(T0 + 3 * MIN, 95.8, 96, 95.6, 95.9)); // jumped from 08:00 to 08:03
    await vi.waitFor(() => expect(listPositions(db, LIVE_ACCOUNT_ID, { status: "closed" })).toHaveLength(1));
    expect(listJournal(db, { mode: "live" }).rows[0].flags).toContain("reconciled_gap");
  });
});
