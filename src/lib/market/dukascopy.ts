/**
 * Dukascopy historical data (Forex, metals) from the public datafeed:
 *   {SYM}/{YYYY}/{MM0}/{DD}/{BID|ASK}_candles_min_1.bi5   — one day of 1m candles
 *   {SYM}/{YYYY}/{MM0}/{BID|ASK}_candles_hour_1.bi5       — one month of 1h candles
 *   {SYM}/{YYYY}/{BID|ASK}_candles_day_1.bi5              — one year of 1d candles
 * (MM0 is the zero-based month.) Files are LZMA-compressed records of 24 bytes:
 *   uint32 seconds-from-period-start, uint32 open, close, low, high (×scale), float32 volume.
 *
 * TradeLab downloads BID and ASK, stores MID prices plus the observed spread, and
 * drops zero-volume flat candles (market closed — no ticks).
 *
 * Access/licensing: free public endpoint, no key. Dukascopy's terms govern use of the
 * data; verify they permit your use before relying on it. Historical only — there is
 * no free public live feed, so Live Paper for FX/metals needs OANDA (see oanda.ts).
 */
import { decompress } from "lzma";
import type { Bar } from "@/lib/engine/types";
import { aggregateBars } from "./aggregate";
import { CATALOG, findCatalog } from "./catalog";
import { RateLimitedFetcher } from "./http";
import { MarketDataError, type FetchOptions, type MarketDataProvider, type ProviderCapabilities, type SymbolInfo } from "./provider";
import { timeframeMs } from "./timeframes";

export const DUKASCOPY_URL = process.env.DUKASCOPY_URL || "https://datafeed.dukascopy.com/datafeed";

const MIN_TFS = new Set(["1m", "3m", "5m", "15m", "30m"]);
const HOUR_TFS = new Set(["1h", "2h", "4h", "6h", "12h"]);
const DAY_TFS = new Set(["1d", "1w"]);
const DAY = 86_400_000;

type Side = "BID" | "ASK";
interface RawCandle {
  time: number;
  open: number;
  close: number;
  low: number;
  high: number;
  volume: number;
}

/** Decode one .bi5 candle file. `periodStart` is the UTC ms the offsets are relative to. */
export function decodeCandleFile(buf: Uint8Array, periodStart: number, scale: number): RawCandle[] {
  if (buf.length === 0) return [];
  const out = decompress(buf);
  const bytes = typeof out === "string" ? Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff) : Uint8Array.from(out, (v) => v & 0xff);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: RawCandle[] = [];
  for (let o = 0; o + 24 <= bytes.length; o += 24) {
    rows.push({
      time: periodStart + view.getUint32(o) * 1000,
      open: view.getUint32(o + 4) / scale,
      close: view.getUint32(o + 8) / scale,
      low: view.getUint32(o + 12) / scale,
      high: view.getUint32(o + 16) / scale,
      volume: view.getFloat32(o + 20),
    });
  }
  return rows;
}

const flat = (c: RawCandle) => c.volume === 0 && c.open === c.close && c.high === c.low && c.open === c.high;

/** Combine BID and ASK candles into MID candles with an observed spread. */
export function mergeBidAsk(bid: RawCandle[], ask: RawCandle[], decimals: number): Bar[] {
  const askBy = new Map(ask.map((a) => [a.time, a]));
  const r = (v: number) => Number(v.toFixed(decimals + 1));
  const out: Bar[] = [];
  for (const b of bid) {
    const a = askBy.get(b.time);
    if (!a) continue; // no matching ask: skip rather than mix price bases
    if (flat(b) && flat(a)) continue; // market closed: no ticks
    out.push({
      time: b.time,
      open: r((b.open + a.open) / 2),
      high: r((b.high + a.high) / 2),
      low: r((b.low + a.low) / 2),
      close: r((b.close + a.close) / 2),
      volume: b.volume,
      spread: r(Math.max(0, (a.open - b.open + (a.close - b.close)) / 2)),
    });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

export class DukascopyProvider implements MarketDataProvider {
  readonly id = "dukascopy" as const;
  readonly name = "Dukascopy (historical)";
  private readonly http: RateLimitedFetcher;

  constructor(
    private readonly baseUrl = DUKASCOPY_URL,
    fetchImpl?: typeof fetch,
    private readonly now: () => number = Date.now,
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.http = new RateLimitedFetcher({ minIntervalMs: 350, maxAttempts: 7, timeoutMs: 60_000, backoff429Ms: 6_000, fetchImpl, sleep });
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      name: this.name,
      assetClasses: ["forex", "metals"],
      historical: true,
      live: false,
      timeframes: [...MIN_TFS, ...HOUR_TFS, ...DAY_TFS],
      bidAsk: { historical: true, live: false },
      priceBasis: "mid",
      liveKind: null,
      requiresCredentials: false,
      configured: true,
      verification: "verified",
      rateLimit: "Aggressive throttling (HTTP 429). Downloads are serialised with backoff; 1h+ timeframes use monthly files (≈24 requests/year), minute data needs 2 requests per day.",
      licensing: "Free public datafeed without a key; usage is subject to Dukascopy's terms — verify they permit your use.",
      notes: [
        "Stored as MID price (average of bid and ask OHLC) with the observed spread per bar; mid high/low are averages of bid/ask extremes (approximation).",
        "Zero-volume flat candles (market closed) are dropped, not shown as trading.",
        "Hourly files for the current month are published after month end; recent days are built from 1m files.",
        "No live feed — use OANDA for FX/metals Live Paper.",
      ],
      delay: "Historical only (typically published within hours)",
    };
  }

  supports(symbol: string): boolean {
    return Boolean(findCatalog(symbol)?.providers.dukascopy);
  }

  nativeSymbol(symbol: string): string {
    return findCatalog(symbol)?.providers.dukascopy ?? symbol.toUpperCase();
  }

  baseTimeframe(timeframe: string): string | undefined {
    if (MIN_TFS.has(timeframe)) return timeframe === "1m" ? undefined : "1m";
    if (HOUR_TFS.has(timeframe)) return timeframe === "1h" ? undefined : "1h";
    if (DAY_TFS.has(timeframe)) return timeframe === "1d" ? undefined : "1d";
    return undefined;
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo> {
    const c = findCatalog(symbol);
    if (!c?.providers.dukascopy) throw new MarketDataError(`Dukascopy does not serve ${symbol}`);
    return { symbol: c.symbol, baseAsset: c.base, quoteAsset: c.quote, tickSize: c.tickSize, qtyStep: c.qtyStep, minQty: c.minQty, contractSize: c.contractSize };
  }

  async checkStatus() {
    const t = Date.now();
    try {
      const res = await this.http.fetch(`${this.baseUrl}/EURUSD/2024/00/BID_candles_hour_1.bi5`);
      return { ok: res.ok, message: res.ok ? "Reachable" : `HTTP ${res.status}`, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), latencyMs: null };
    }
  }

  private async file(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.http.fetch(`${this.baseUrl}/${path}`, {}, signal);
    if (res.status === 404) return new Uint8Array(0); // no data for that period
    if (!res.ok) throw new MarketDataError(`Dukascopy HTTP ${res.status} for ${path}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async period(sym: string, kind: "min" | "hour" | "day", start: number, scale: number, decimals: number, signal?: AbortSignal): Promise<Bar[]> {
    const d = new Date(start);
    const y = d.getUTCFullYear();
    const m = pad(d.getUTCMonth());
    const file = kind === "min" ? `${y}/${m}/${pad(d.getUTCDate())}/%s_candles_min_1.bi5` : kind === "hour" ? `${y}/${m}/%s_candles_hour_1.bi5` : `${y}/%s_candles_day_1.bi5`;
    const fetchSide = async (side: Side) => decodeCandleFile(await this.file(`${sym}/${file.replace("%s", side)}`, signal), start, scale);
    const bid = await fetchSide("BID");
    const ask = await fetchSide("ASK");
    return mergeBidAsk(bid, ask, decimals);
  }

  /**
   * Fetch candles in the base resolutions (1m/1h/1d) by downloading whole period
   * files, then trim to [from, to]. Higher timeframes are aggregated.
   */
  async fetchCandles(symbol: string, timeframe: string, from: number, to: number, opts: FetchOptions = {}): Promise<Bar[]> {
    const c = findCatalog(symbol);
    if (!c?.providers.dukascopy) throw new MarketDataError(`Dukascopy does not serve ${symbol}`);
    const base = this.baseTimeframe(timeframe) ?? timeframe;
    if (!["1m", "1h", "1d"].includes(base)) throw new MarketDataError(`Dukascopy does not support timeframe ${timeframe}`);
    const sym = c.providers.dukascopy;
    const scale = c.dukascopyScale ?? 100_000;
    const decimals = Math.max(0, Math.round(Math.log10(scale)));
    const now = this.now();
    const end = Math.min(to + timeframeMs(timeframe), now);

    // Plan the period files to fetch.
    const plan: { kind: "min" | "hour" | "day"; start: number }[] = [];
    if (base === "1m") {
      for (let t = Math.floor(from / DAY) * DAY; t < end; t += DAY) plan.push({ kind: "min", start: t });
    } else if (base === "1h") {
      const d = new Date(from);
      let y = d.getUTCFullYear();
      let mo = d.getUTCMonth();
      const nowD = new Date(now);
      for (;;) {
        const start = Date.UTC(y, mo, 1);
        if (start >= end) break;
        const isCurrentMonth = y === nowD.getUTCFullYear() && mo === nowD.getUTCMonth();
        if (isCurrentMonth) {
          // Monthly hour files appear after month end: build this month from 1m day files.
          for (let t = Math.max(start, Math.floor(from / DAY) * DAY); t < Math.min(end, Math.floor(now / DAY) * DAY); t += DAY) plan.push({ kind: "min", start: t });
        } else plan.push({ kind: "hour", start });
        mo++;
        if (mo === 12) {
          mo = 0;
          y++;
        }
      }
    } else {
      for (let y = new Date(from).getUTCFullYear(); Date.UTC(y, 0, 1) < end; y++) plan.push({ kind: "day", start: Date.UTC(y, 0, 1) });
    }

    const bars: Bar[] = [];
    for (let i = 0; i < plan.length; i++) {
      opts.onProgress?.(i, plan.length);
      const p = plan[i];
      const got = await this.period(sym, p.kind, p.start, scale, decimals, opts.signal);
      bars.push(...(p.kind === "min" && base === "1h" ? aggregateBars(got, "1h") : got));
    }
    opts.onProgress?.(plan.length, plan.length);
    bars.sort((a, b) => a.time - b.time);
    const closed = (b: Bar) => b.time + timeframeMs(base) <= now;
    const inRange = bars.filter((b) => closed(b));
    const result = timeframe === base ? inRange : aggregateBars(inRange, timeframe, now);
    return result.filter((b) => b.time >= from && b.time <= to);
  }

  async fetchRecent(symbol: string, timeframe: string, limit: number, endTime?: number): Promise<Bar[]> {
    const end = endTime ?? this.now();
    const span = timeframeMs(timeframe) * limit * 1.6; // weekends
    const bars = await this.fetchCandles(symbol, timeframe, end - span, end);
    return bars.slice(-limit);
  }

  /** Publication lag: data newer than this may still appear, so don't mark it covered. */
  publishedUntil(): number {
    return this.now() - 2 * DAY;
  }
}

export const DUKASCOPY_SYMBOLS = CATALOG.filter((c) => c.providers.dukascopy).map((c) => c.symbol);
