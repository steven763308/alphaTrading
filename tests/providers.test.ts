import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateBars } from "@/lib/market/aggregate";
import { parseAlpacaBars, parseAlpacaStream, AlpacaProvider } from "@/lib/market/alpaca";
import { decodeCandleFile, DukascopyProvider, mergeBidAsk } from "@/lib/market/dukascopy";
import { OandaProvider, parseOandaCandles, parseOandaPriceLine } from "@/lib/market/oanda";
import { dukascopyFixtureFetch } from "./dukascopy-fixture";

const FIX = path.join(__dirname, "fixtures", "dukascopy");
const FEB = Date.UTC(2024, 1, 1);

describe("Dukascopy decoding (real XAUUSD February 2024 files)", () => {
  const bid = decodeCandleFile(fs.readFileSync(path.join(FIX, "XAUUSD_2024_01_BID_candles_hour_1.bi5")), FEB, 1000);
  const ask = decodeCandleFile(fs.readFileSync(path.join(FIX, "XAUUSD_2024_01_ASK_candles_hour_1.bi5")), FEB, 1000);

  it("decodes 696 hourly records (29 days) per side", () => {
    expect(bid).toHaveLength(696);
    expect(ask).toHaveLength(696);
    expect(bid[0]).toMatchObject({ time: FEB, open: 2039.855 });
    expect(ask[0]).toMatchObject({ time: FEB, open: 2040.155, close: 2040.992, low: 2039.395, high: 2042.865 });
  });

  it("builds MID candles with the observed spread and drops closed-market hours", () => {
    const mid = mergeBidAsk(bid, ask, 3);
    expect(mid).toHaveLength(481); // weekends + daily 17:00 NY break removed
    expect(mid[0]).toMatchObject({ time: FEB, open: 2040.005, close: 2040.8185, spread: 0.3235 });
    for (const b of mid) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close) - 1e-9);
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close) + 1e-9);
      expect(b.spread).toBeGreaterThan(0);
    }
    // No Saturday bars.
    expect(mid.some((b) => new Date(b.time).getUTCDay() === 6)).toBe(false);
  });

  it("aggregates hours to 4h buckets", () => {
    const four = aggregateBars(mergeBidAsk(bid, ask, 3), "4h");
    const first = four[0];
    expect(first.time).toBe(FEB);
    expect(first.open).toBe(2040.005);
  });

  it("fetches through the provider with rate-limited requests, 404 = no data", async () => {
    const calls: string[] = [];
    const p = new DukascopyProvider("https://datafeed.dukascopy.com/datafeed", dukascopyFixtureFetch(calls), () => Date.UTC(2024, 2, 15), async () => {});
    const bars = await p.fetchCandles("XAUUSD", "4h", Date.UTC(2024, 0, 25), Date.UTC(2024, 1, 10));
    expect(calls.some((u) => u.includes("/2024/00/BID_candles_hour_1"))).toBe(true); // January requested (404)
    expect(bars[0].time).toBe(FEB);
    expect(bars.every((b) => b.time % (4 * 3_600_000) === 0)).toBe(true);
    expect(p.supports("XAUUSD")).toBe(true);
    expect(p.supports("BTCUSDT")).toBe(false);
    expect(p.capabilities().live).toBe(false);
  });
});

describe("OANDA adapter (documented v20 formats)", () => {
  it("parses MBA candles into MID bars with spread and skips incomplete candles", () => {
    const bars = parseOandaCandles([
      { time: "2024-02-05T10:00:00.000000000Z", complete: true, volume: 1200, mid: { o: "1.07850", h: "1.07900", l: "1.07800", c: "1.07880" }, bid: { o: "1.07845", h: "1.07895", l: "1.07795", c: "1.07874" }, ask: { o: "1.07855", h: "1.07905", l: "1.07805", c: "1.07886" } },
      { time: "2024-02-05T10:01:00.000000000Z", complete: false, volume: 10, mid: { o: "1.07880", h: "1.07890", l: "1.07870", c: "1.07885" } },
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ time: Date.UTC(2024, 1, 5, 10), open: 1.0785, close: 1.0788 });
    expect(bars[0].spread).toBeCloseTo(0.00012, 10);
  });

  it("parses pricing stream lines and ignores heartbeats", () => {
    expect(parseOandaPriceLine('{"type":"HEARTBEAT","time":"2024-02-05T10:00:05Z"}')).toBeNull();
    const q = parseOandaPriceLine('{"type":"PRICE","instrument":"XAU_USD","time":"2024-02-05T10:00:05.123Z","bids":[{"price":"2030.10","liquidity":1}],"asks":[{"price":"2030.45","liquidity":1}]}');
    expect(q).toEqual({ instrument: "XAU_USD", bid: 2030.1, ask: 2030.45, time: Date.parse("2024-02-05T10:00:05.123Z") });
  });

  it("is unavailable (not substituted) without credentials", async () => {
    const p = new OandaProvider("", "");
    expect(p.capabilities().configured).toBe(false);
    expect(p.capabilities().verification).toBe("unverified");
    await expect(p.fetchCandles("EURUSD", "1h", 0, 1)).rejects.toThrow(/not configured/);
    expect((await p.checkStatus()).ok).toBe(false);
  });
});

describe("Alpaca adapter (documented v2 formats)", () => {
  it("parses bars and stream events", () => {
    expect(parseAlpacaBars([{ t: "2024-02-05T14:30:00Z", o: 188.15, h: 188.9, l: 187.6, c: 188.4, v: 12345 }])[0]).toEqual({ time: Date.UTC(2024, 1, 5, 14, 30), open: 188.15, high: 188.9, low: 187.6, close: 188.4, volume: 12345 });
    const ev = parseAlpacaStream('[{"T":"success","msg":"authenticated"},{"T":"q","S":"AAPL","bp":188.1,"ap":188.12,"t":"2024-02-05T14:30:01Z"},{"T":"b","S":"AAPL","o":1,"h":2,"l":0.5,"c":1.5,"v":10,"t":"2024-02-05T14:30:00Z"},{"T":"error","code":402,"msg":"auth failed"}]');
    expect(ev.map((e) => e.kind)).toEqual(["status", "quote", "bar", "status"]);
    expect(ev[1]).toMatchObject({ symbol: "AAPL", bid: 188.1, ask: 188.12 });
    expect(ev[3]).toMatchObject({ ok: false });
  });

  it("discloses the IEX feed limitation and is unavailable without keys", async () => {
    const p = new AlpacaProvider("", "", "iex");
    expect(p.capabilities().notes.join(" ")).toMatch(/IEX/);
    await expect(p.fetchCandles("AAPL", "1d", 0, 1)).rejects.toThrow(/not configured/);
  });
});
