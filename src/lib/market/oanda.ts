/**
 * OANDA v20 market data (Forex, metals) — historical candles and live pricing stream.
 * Requires a (free) fxTrade Practice account token: OANDA_API_TOKEN, OANDA_ACCOUNT_ID.
 * TradeLab only calls read-only market-data endpoints; it never places orders.
 *
 * Implemented from OANDA's public v20 documentation. Status: UNVERIFIED until run
 * with real credentials (see Settings → Data providers → Test).
 */
import type { Bar } from "@/lib/engine/types";
import { CATALOG, findCatalog } from "./catalog";
import { RateLimitedFetcher } from "./http";
import {
  MarketDataError,
  ProviderUnavailableError,
  type FetchOptions,
  type MarketDataProvider,
  type ProviderCapabilities,
  type StreamConnection,
  type StreamHandlers,
  type StreamKey,
  type SymbolInfo,
} from "./provider";
import { timeframeMs } from "./timeframes";

const GRANULARITY: Record<string, string> = { "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "2h": "H2", "4h": "H4", "6h": "H6", "12h": "H12", "1d": "D", "1w": "W" };
const MAX_CANDLES = 5000;

export interface OandaCandle {
  time: string;
  complete: boolean;
  volume: number;
  mid?: { o: string; h: string; l: string; c: string };
  bid?: { o: string; h: string; l: string; c: string };
  ask?: { o: string; h: string; l: string; c: string };
}

/** Map OANDA candles (price=MBA) to bars: MID OHLC + close spread. Incomplete candles dropped. */
export function parseOandaCandles(candles: OandaCandle[]): Bar[] {
  const out: Bar[] = [];
  for (const k of candles) {
    if (!k.complete || !k.mid) continue;
    const spread = k.bid && k.ask ? Math.max(0, Number(k.ask.c) - Number(k.bid.c)) : undefined;
    out.push({
      time: Date.parse(k.time),
      open: Number(k.mid.o),
      high: Number(k.mid.h),
      low: Number(k.mid.l),
      close: Number(k.mid.c),
      volume: k.volume,
      ...(spread != null ? { spread } : {}),
    });
  }
  return out;
}

/** Parse one line of the pricing stream. Returns null for heartbeats/other messages. */
export function parseOandaPriceLine(line: string): { instrument: string; bid: number; ask: number; time: number } | null {
  if (!line.trim()) return null;
  const msg = JSON.parse(line) as { type?: string; instrument?: string; time?: string; bids?: { price: string }[]; asks?: { price: string }[] };
  if (msg.type !== "PRICE" || !msg.instrument || !msg.bids?.length || !msg.asks?.length) return null;
  return { instrument: msg.instrument, bid: Number(msg.bids[0].price), ask: Number(msg.asks[0].price), time: Date.parse(msg.time!) };
}

export class OandaProvider implements MarketDataProvider {
  readonly id = "oanda" as const;
  readonly name = "OANDA v20 (practice)";
  private readonly http: RateLimitedFetcher;
  private readonly rest: string;
  private readonly stream: string;

  constructor(
    private readonly token = process.env.OANDA_API_TOKEN ?? "",
    private readonly accountId = process.env.OANDA_ACCOUNT_ID ?? "",
    env = process.env.OANDA_ENV === "live" ? "live" : "practice",
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.rest = env === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
    this.stream = env === "live" ? "https://stream-fxtrade.oanda.com" : "https://stream-fxpractice.oanda.com";
    this.http = new RateLimitedFetcher({ minIntervalMs: 50, maxAttempts: 3, timeoutMs: 20_000, backoff429Ms: 2_000, fetchImpl });
  }

  private get configured() {
    return Boolean(this.token && this.accountId);
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      name: this.name,
      assetClasses: ["forex", "metals"],
      historical: true,
      live: true,
      timeframes: Object.keys(GRANULARITY),
      bidAsk: { historical: true, live: true },
      priceBasis: "mid",
      liveKind: "quote",
      requiresCredentials: true,
      configured: this.configured,
      verification: "unverified",
      rateLimit: "~120 requests/s per token; max 5,000 candles per request; 2 streaming connections per account.",
      licensing: "Requires an OANDA account (free practice accounts available); data use subject to OANDA's terms.",
      notes: this.configured
        ? ["Read-only market data endpoints only — no orders are ever sent."]
        : ["Not configured: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID in .env.local (free fxTrade Practice account)."],
      delay: "Real-time (practice pricing)",
    };
  }

  supports(symbol: string): boolean {
    return Boolean(findCatalog(symbol)?.providers.oanda);
  }

  nativeSymbol(symbol: string): string {
    return findCatalog(symbol)?.providers.oanda ?? symbol;
  }

  private assertConfigured() {
    if (!this.configured) throw new ProviderUnavailableError("OANDA is not configured (set OANDA_API_TOKEN and OANDA_ACCOUNT_ID)");
  }

  private headers() {
    return { Authorization: `Bearer ${this.token}`, "Accept-Datetime-Format": "RFC3339" };
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo> {
    const c = findCatalog(symbol);
    if (!c?.providers.oanda) throw new MarketDataError(`OANDA does not serve ${symbol}`);
    return { symbol: c.symbol, baseAsset: c.base, quoteAsset: c.quote, tickSize: c.tickSize, qtyStep: c.qtyStep, minQty: c.minQty, contractSize: c.contractSize };
  }

  async checkStatus() {
    if (!this.configured) return { ok: false, message: "Not configured (needs OANDA_API_TOKEN and OANDA_ACCOUNT_ID)", latencyMs: null };
    const t = Date.now();
    try {
      const res = await this.http.fetch(`${this.rest}/v3/instruments/EUR_USD/candles?count=1&granularity=M1`, { headers: this.headers() });
      return { ok: res.ok, message: res.ok ? "Authenticated" : `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), latencyMs: null };
    }
  }

  async fetchCandles(symbol: string, timeframe: string, from: number, to: number, opts: FetchOptions = {}): Promise<Bar[]> {
    this.assertConfigured();
    const g = GRANULARITY[timeframe];
    if (!g) throw new MarketDataError(`OANDA does not support timeframe ${timeframe}`);
    const step = timeframeMs(timeframe);
    const inst = this.nativeSymbol(symbol);
    const out: Bar[] = [];
    let cursor = from;
    const pages = Math.max(1, Math.ceil((to - from) / step / MAX_CANDLES));
    let page = 0;
    while (cursor <= to) {
      opts.onProgress?.(page++, pages);
      const chunkEnd = Math.min(to, cursor + step * (MAX_CANDLES - 1));
      const url = `${this.rest}/v3/instruments/${inst}/candles?price=MBA&granularity=${g}&from=${new Date(cursor).toISOString()}&to=${new Date(chunkEnd + 1).toISOString()}&alignmentTimezone=UTC&dailyAlignment=0`;
      const res = await this.http.fetch(url, { headers: this.headers() }, opts.signal);
      if (!res.ok) throw new MarketDataError(`OANDA HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { candles: OandaCandle[] };
      out.push(...parseOandaCandles(data.candles).filter((b) => b.time >= from && b.time <= to));
      cursor = chunkEnd + step;
    }
    return out;
  }

  async fetchRecent(symbol: string, timeframe: string, limit: number, endTime?: number): Promise<Bar[]> {
    this.assertConfigured();
    const g = GRANULARITY[timeframe];
    if (!g) throw new MarketDataError(`OANDA does not support timeframe ${timeframe}`);
    const to = endTime ? `&to=${new Date(endTime).toISOString()}` : "";
    const res = await this.http.fetch(`${this.rest}/v3/instruments/${this.nativeSymbol(symbol)}/candles?price=MBA&granularity=${g}&count=${Math.min(limit, MAX_CANDLES)}${to}`, { headers: this.headers() });
    if (!res.ok) throw new MarketDataError(`OANDA HTTP ${res.status}`);
    const data = (await res.json()) as { candles: OandaCandle[] };
    // Include the forming candle for charts.
    return data.candles.filter((k) => k.mid).map((k) => ({ ...parseOandaCandles([{ ...k, complete: true }])[0] }));
  }

  /** Pricing stream (quotes). The instrument set is fixed per connection, so changes reconnect. */
  openStream(initial: StreamKey[], handlers: StreamHandlers): StreamConnection {
    let controller: AbortController | null = null;
    let closed = false;
    const start = (keys: StreamKey[]) => {
      controller?.abort();
      const instruments = [...new Set(keys.map((k) => k.symbol))];
      if (!this.configured || instruments.length === 0) {
        handlers.onStatus("disconnected", this.configured ? "no instruments" : "OANDA not configured");
        return;
      }
      const ctl = new AbortController();
      controller = ctl;
      handlers.onStatus("connecting");
      (async () => {
        try {
          const res = await this.fetchImpl(`${this.stream}/v3/accounts/${this.accountId}/pricing/stream?instruments=${instruments.join(",")}`, { headers: this.headers(), signal: ctl.signal });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          handlers.onStatus("connected");
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              const q = parseOandaPriceLine(line);
              if (q) handlers.onQuote?.({ symbol: q.instrument, bid: q.bid, ask: q.ask, time: q.time });
            }
          }
          if (!closed && controller === ctl) handlers.onStatus("disconnected", "stream ended");
        } catch (e) {
          if (!closed && controller === ctl) handlers.onStatus("disconnected", e instanceof Error ? e.message : String(e));
        }
      })();
    };
    start(initial);
    let current = initial.map((k) => k.symbol).sort().join(",");
    return {
      setStreams(keys) {
        const next = [...new Set(keys.map((k) => k.symbol))].sort().join(",");
        if (next !== current) {
          current = next;
          start(keys);
        }
      },
      close() {
        closed = true;
        controller?.abort();
      },
    };
  }
}

export const OANDA_SYMBOLS = CATALOG.filter((c) => c.providers.oanda).map((c) => c.symbol);
