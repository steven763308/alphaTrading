import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DukascopyProvider } from "@/lib/market/dukascopy";
import { openDb, type Db } from "@/lib/server/db/client";
import { tradeJournal } from "@/lib/server/db/schema";
import { listJournal } from "@/lib/server/repo/journal";
import { getOrCreateDataset, upsertInstrument, uncoveredRanges, addCoverage } from "@/lib/server/repo/market";
import { advanceSession, createSession, getSessionView, sessionCommand, verifyReplay } from "@/lib/server/services/backtest";
import { importCsv } from "@/lib/server/services/csv-import";
import { conversionPair, resolveProvider, setProvider } from "@/lib/server/services/market-data";
import { dukascopyFixtureFetch } from "./dukascopy-fixture";

let db: Db;
let calls: string[];

beforeEach(() => {
  db = openDb(":memory:").db;
  calls = [];
  setProvider("dukascopy", new DukascopyProvider("https://datafeed.dukascopy.com/datafeed", dukascopyFixtureFetch(calls), () => Date.UTC(2024, 2, 15), async () => {}));
});

async function step(id: string, steps = 1) {
  const rev = getSessionView(db, id).session.revision;
  return advanceSession(db, id, { steps, revision: rev });
}

describe("historical XAUUSD (acceptance) — real Dukascopy data", () => {
  const FROM = Date.UTC(2024, 1, 6);
  const TO = Date.UTC(2024, 1, 28, 23);

  async function goldSession(extra: Partial<Parameters<typeof createSession>[1]> = {}) {
    return createSession(db, { source: "dukascopy", symbol: "XAUUSD", timeframe: "1h", from: FROM, to: TO, startingBalance: 10_000, ...extra });
  }

  it("creates a metals session with gold contract specs, USD account, mid prices and spreads", async () => {
    const v = await goldSession();
    expect(v.instrument).toMatchObject({ symbol: "XAUUSD", market: "metals", contractSize: 100, unit: "lot", calendar: "metals", leverage: 20 });
    expect(v.account.currency).toBe("USD");
    expect(v.priceBasis).toBe("mid");
    expect(v.leverage).toBe(20);
    expect(v.cursorBar?.spread).toBeGreaterThan(0);
    expect(v.warnings.join(" ")).toMatch(/MID/);
    expect(v.session.resolveLowerTf).toBe(false); // per-bar Dukascopy downloads would be too slow
  });

  it("trades 0.10 lot of gold with market-specific P&L, costs and financing, and journals it", async () => {
    const v = await goldSession();
    const entryPrice = v.price;
    const r = sessionCommand(db, v.session.id, { kind: "place", clientOrderId: "g1", side: "buy", type: "market", qty: 0.1, sl: Math.round((entryPrice - 15) * 100) / 100, tp: Math.round((entryPrice + 15) * 100) / 100 });
    expect(r.rejected).toBeNull();
    const pos = r.view.openPositions[0];
    // Bought at the ask (mid + half the observed spread), USD-denominated: margin = notional / 20.
    expect(pos.entryPrice).toBeGreaterThan(entryPrice);
    expect(pos.margin).toBeCloseTo((pos.entryPrice * 0.1 * 100) / 20, 6);
    expect(pos.initialRisk).toBeCloseTo((pos.entryPrice - pos.sl!) * 0.1 * 100, 6);

    for (let i = 0; i < 400 && getSessionView(db, v.session.id).openPositions.length; i++) await step(v.session.id, 1);
    const j = listJournal(db, { sessionId: v.session.id }).rows[0];
    expect(j).toBeTruthy();
    expect(j.market).toBe("metals");
    expect(j.accountCurrency).toBe("USD");
    expect(["stop_loss", "take_profit"]).toContain(j.exitReason);
    // Gross P&L in USD = price move × 0.1 lot × 100 oz.
    expect(j.grossPnl).toBeCloseTo((j.exitPrice - j.entryPrice) * 0.1 * 100, 6);
    expect(j.netPnl).toBeCloseTo(j.grossPnl - j.fees + j.financing, 6);
    if (j.exitTime - j.entryTime > 24 * 3_600_000) expect(j.financing).toBeLessThan(0); // held over a rollover
    expect((await verifyReplay(db, v.session.id)).ok).toBe(true);
  });

  it("rejects a gold order that needs more margin than the account has", async () => {
    const v = await goldSession({ startingBalance: 1_000 });
    const r = sessionCommand(db, v.session.id, { kind: "place", clientOrderId: "g2", side: "buy", type: "market", qty: 1 });
    expect(r.rejected).toMatch(/Insufficient margin/);
  });

  it("caches downloads: a second session over the same range makes no new requests", async () => {
    await goldSession();
    const before = calls.length;
    await goldSession();
    expect(calls.length).toBe(before);
  });
});

describe("resumable downloads", () => {
  it("keeps completed files when rate limiting fails a later one, and resumes on retry", async () => {
    let throttle = true;
    const seen: string[] = [];
    const base = dukascopyFixtureFetch(seen);
    const flaky = (async (input: RequestInfo | URL) => {
      if (throttle && String(input).includes("/2024/01/ASK")) return new Response("Too Many Requests", { status: 429 });
      return base(input);
    }) as typeof fetch;
    setProvider("dukascopy", new DukascopyProvider("https://datafeed.dukascopy.com/datafeed", flaky, () => Date.UTC(2024, 2, 15), async () => {}));
    const input = { source: "dukascopy", symbol: "XAUUSD", timeframe: "1h", from: Date.UTC(2024, 1, 6), to: Date.UTC(2024, 1, 20), startingBalance: 10_000 };
    await expect(createSession(db, input)).rejects.toThrow(/parts were saved/);
    const januaryRequests = seen.filter((u) => u.includes("/2024/00/")).length;
    expect(januaryRequests).toBeGreaterThan(0);
    throttle = false;
    const v = await createSession(db, input);
    expect(v.session.id).toBeTruthy();
    // January (already covered, no data) was not requested again.
    expect(seen.filter((u) => u.includes("/2024/00/")).length).toBe(januaryRequests);
  });
});

describe("incremental coverage", () => {
  it("skips ranges already fetched even when they contain no candles (e.g. weekends)", () => {
    const inst = upsertInstrument(db, "dukascopy", { symbol: "EURUSD", baseAsset: "EUR", quoteAsset: "USD", tickSize: 0.00001, qtyStep: 0.01, minQty: 0.01, contractSize: 100_000 }, "forex");
    const ds = getOrCreateDataset(db, "dukascopy", inst.id, "1h", "live-cache");
    const H = 3_600_000;
    expect(uncoveredRanges(db, ds.id, 0, 47 * H, H)).toEqual([[0, 47 * H]]);
    addCoverage(db, ds.id, 0, 23 * H, H);
    expect(uncoveredRanges(db, ds.id, 0, 47 * H, H)).toEqual([[24 * H, 47 * H]]);
    addCoverage(db, ds.id, 24 * H, 47 * H, H); // adjacent → merged
    expect(uncoveredRanges(db, ds.id, 0, 47 * H, H)).toEqual([]);
  });
});

describe("availability and conversion routing", () => {
  it("reports live FX/metals as unavailable without OANDA (no substitution)", () => {
    const live = resolveProvider("XAUUSD", "live");
    expect(live.provider).toBeNull();
    expect(live.reason).toMatch(/OANDA/);
    expect(resolveProvider("XAUUSD", "historical").provider).toBe("dukascopy");
    expect(resolveProvider("AAPL", "historical").reason).toMatch(/Alpaca/);
    expect(resolveProvider("BTCUSDT", "live").provider).toBe("binance");
  });

  it("picks identity / inverse / cross-rate conversions", () => {
    const i = (symbol: string, baseAsset: string, quoteAsset: string) => ({ symbol, baseAsset, quoteAsset });
    expect(conversionPair(i("XAUUSD", "XAU", "USD"), "USD")).toEqual({ kind: "identity" });
    expect(conversionPair(i("BTCUSDT", "BTC", "USDT"), "USD")).toEqual({ kind: "identity" }); // USDT ≈ USD
    expect(conversionPair(i("USDJPY", "USD", "JPY"), "USD")).toEqual({ kind: "inverse" });
    expect(conversionPair(i("EURGBP", "EUR", "GBP"), "USD")).toEqual({ kind: "rate", pair: "GBPUSD", invert: false });
    expect(conversionPair(i("EURJPY", "EUR", "JPY"), "USD")).toEqual({ kind: "rate", pair: "USDJPY", invert: true });
  });
});

describe("cross-currency session (CSV data)", () => {
  // Synthetic flat candles: this test checks conversion arithmetic, not market behaviour.
  const csv = (rows: [string, number][]) => ["time,open,high,low,close", ...rows.map(([t, p]) => `${t},${p},${p + 0.0005},${p - 0.0005},${p}`)].join("\n");
  const hours = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 1, 5, i)).toISOString());

  it("converts EURGBP P&L to USD using GBPUSD closes", async () => {
    const t = hours(10);
    importCsv(db, { symbol: "GBPUSD", timeframe: "1h", text: csv(t.map((x) => [x, 1.25])), tickSize: 0.00001, qtyStep: 0.01, contractSize: 100_000, market: "forex" });
    const eg = importCsv(db, { symbol: "EURGBP", timeframe: "1h", text: csv(t.map((x, i) => [x, i < 5 ? 0.855 : 0.856])), tickSize: 0.00001, qtyStep: 0.01, contractSize: 100_000, market: "forex" });
    // CSV instruments have no catalog quote; set it as an FX cross.
    db.update((await import("@/lib/server/db/schema")).instruments).set({ baseAsset: "EUR", quoteAsset: "GBP", leverage: 30 }).where(eq((await import("@/lib/server/db/schema")).instruments.id, eg.instrument.id)).run();
    const v = await createSession(db, { source: "csv", datasetId: eg.dataset.id, timeframe: "1h", from: Date.UTC(2024, 1, 5, 1), to: Date.UTC(2024, 1, 5, 9), startingBalance: 10_000, costs: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 0, slippageBps: 0 } });
    expect(v.session.conversionDatasetId).not.toBeNull();
    expect(v.conversion).toEqual({ kind: "rate", rate: 1.25 });
    sessionCommand(db, v.session.id, { kind: "place", clientOrderId: "x1", side: "buy", type: "market", qty: 1 }); // @0.855
    await step(v.session.id, 5); // price now 0.856
    const pos = getSessionView(db, v.session.id).openPositions[0];
    sessionCommand(db, v.session.id, { kind: "close", positionId: pos.id });
    const j = db.select().from(tradeJournal).where(eq(tradeJournal.sessionId, v.session.id)).get()!;
    expect(j.grossPnl).toBeCloseTo(0.001 * 100_000 * 1.25, 6); // £100 × 1.25 = $125
    expect(j.quoteCurrency).toBe("GBP");
    expect((await verifyReplay(db, v.session.id)).ok).toBe(true);
  });
});
