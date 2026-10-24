import type { Bar } from "@/lib/engine/types";
import { findCatalog } from "./catalog";
import {
  MarketDataError,
  type FetchOptions,
  type MarketDataProvider,
  type ProviderCapabilities,
  type StreamConnection,
  type StreamHandlers,
  type StreamKey,
  type SymbolInfo,
} from "./provider";
import { TIMEFRAMES, timeframeMs } from "./timeframes";

/**
 * Binance public market data (spot). No API key needed.
 * Defaults to the market-data-only mirrors, which are reachable in regions where
 * api.binance.com is blocked. Override with BINANCE_REST_URL / BINANCE_WS_URL.
 */
export const BINANCE_REST_URL = process.env.BINANCE_REST_URL || "https://data-api.binance.vision";
export const BINANCE_WS_URL = process.env.BINANCE_WS_URL || "wss://data-stream.binance.vision";

const MAX_LIMIT = 1000;

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

function toBar(k: RawKline): Bar {
  return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
}

async function getJson<T>(url: string, fetchImpl: typeof fetch, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (res.status === 429 || res.status === 418) {
        const wait = Number(res.headers.get("retry-after") ?? "2") * 1000;
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        continue;
      }
      if (!res.ok) throw new MarketDataError(`Binance ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof MarketDataError && !/5\d\d/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new MarketDataError(`Binance request failed: ${url}`, lastErr);
}

export class BinanceProvider implements MarketDataProvider {
  readonly id = "binance" as const;
  readonly name = "Binance Spot (public)";

  constructor(
    private readonly restUrl = BINANCE_REST_URL,
    private readonly wsUrl = BINANCE_WS_URL,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      name: this.name,
      assetClasses: ["crypto"],
      historical: true,
      live: true,
      timeframes: [...TIMEFRAMES],
      bidAsk: { historical: false, live: false },
      priceBasis: "trade",
      liveKind: "kline",
      requiresCredentials: false,
      configured: true,
      verification: "verified",
      rateLimit: "6,000 request weight/min per IP (klines = 2)",
      licensing: "Public market data endpoints; subject to Binance Terms of Use.",
      notes: ["Candles are last-trade prices; spread is a configured assumption.", `REST ${this.restUrl}`, `WS ${this.wsUrl}`],
      delay: "Real-time",
    };
  }

  supports(symbol: string): boolean {
    const c = findCatalog(symbol);
    if (c) return Boolean(c.providers.binance);
    return /^[A-Z0-9]{2,15}(USDT|USDC|FDUSD|BTC|ETH)$/.test(symbol.toUpperCase());
  }

  nativeSymbol(symbol: string): string {
    return symbol.toUpperCase();
  }

  async checkStatus() {
    const t = Date.now();
    try {
      await getJson(`${this.restUrl}/api/v3/ping`, this.fetchImpl, 1);
      return { ok: true, message: "Reachable", latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), latencyMs: null };
    }
  }

  async fetchCandles(symbol: string, timeframe: string, from: number, to: number, opts: FetchOptions = {}): Promise<Bar[]> {
    const step = timeframeMs(timeframe);
    const out: Bar[] = [];
    let cursor = from;
    const now = this.now();
    const pages = Math.max(1, Math.ceil((to - from) / step / MAX_LIMIT));
    let done = 0;
    while (cursor <= to) {
      opts.onProgress?.(done++, pages);
      const url = `${this.restUrl}/api/v3/klines?symbol=${symbol}&interval=${timeframe}&startTime=${cursor}&endTime=${to}&limit=${MAX_LIMIT}`;
      const rows = await getJson<RawKline[]>(url, this.fetchImpl);
      if (rows.length === 0) break;
      for (const k of rows) {
        // Only closed candles: close time must be in the past.
        if (k[6] < now) out.push(toBar(k));
      }
      const last = rows[rows.length - 1][0];
      if (rows.length < MAX_LIMIT) break;
      cursor = last + step;
    }
    return out;
  }

  async fetchRecent(symbol: string, timeframe: string, limit: number, endTime?: number): Promise<Bar[]> {
    const lim = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const end = endTime ? `&endTime=${endTime}` : "";
    const rows = await getJson<RawKline[]>(
      `${this.restUrl}/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=${lim}${end}`,
      this.fetchImpl,
    );
    return rows.map(toBar);
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo> {
    type Info = {
      symbols: {
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        filters: { filterType: string; tickSize?: string; stepSize?: string; minQty?: string }[];
      }[];
    };
    const data = await getJson<Info>(`${this.restUrl}/api/v3/exchangeInfo?symbol=${symbol}`, this.fetchImpl);
    const s = data.symbols?.[0];
    if (!s) throw new MarketDataError(`Unknown Binance symbol ${symbol}`);
    const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
    const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
    return {
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      tickSize: Number(price?.tickSize ?? "0.01"),
      qtyStep: Number(lot?.stepSize ?? "0.00001"),
      minQty: Number(lot?.minQty ?? "0.00001"),
      contractSize: 1,
    };
  }

  openStream(initial: StreamKey[], handlers: StreamHandlers): StreamConnection {
    const name = (k: StreamKey) => `${k.symbol.toLowerCase()}@kline_${k.timeframe}`;
    let current = new Set(initial.map(name));
    let closedByUser = false;
    let msgId = 1;
    const ws = new WebSocket(`${this.wsUrl}/stream?streams=${[...current].join("/")}`);
    handlers.onStatus("connecting");
    ws.onopen = () => handlers.onStatus("connected");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          data?: { e: string; E: number; s: string; k: { t: number; i: string; o: string; h: string; l: string; c: string; v: string; x: boolean } };
        };
        const d = msg.data;
        if (!d || d.e !== "kline") return;
        const k = d.k;
        handlers.onCandle({
          symbol: d.s,
          timeframe: k.i,
          bar: { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v },
          closed: k.x,
          eventTime: d.E,
        });
      } catch {
        // Ignore malformed frames; staleness detection handles silent feeds.
      }
    };
    ws.onerror = () => handlers.onStatus("disconnected", "WebSocket error");
    ws.onclose = (ev) => {
      if (!closedByUser) handlers.onStatus("disconnected", `closed (${ev.code})`);
    };
    return {
      setStreams(streams: StreamKey[]) {
        const next = new Set(streams.map(name));
        const add = [...next].filter((n) => !current.has(n));
        const remove = [...current].filter((n) => !next.has(n));
        current = next;
        if (ws.readyState !== WebSocket.OPEN) return;
        if (add.length) ws.send(JSON.stringify({ method: "SUBSCRIBE", params: add, id: msgId++ }));
        if (remove.length) ws.send(JSON.stringify({ method: "UNSUBSCRIBE", params: remove, id: msgId++ }));
      },
      close() {
        closedByUser = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}
