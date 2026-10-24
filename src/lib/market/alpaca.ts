/**
 * Alpaca Market Data v2 (US stocks/ETFs) — historical bars and live quotes/bars.
 * Requires free Alpaca API keys: ALPACA_KEY_ID, ALPACA_SECRET_KEY. The free plan
 * uses the IEX feed (ALPACA_FEED=iex): real-time but IEX-exchange-only prices, which
 * can differ from the consolidated tape. Read-only market data; no orders are sent.
 *
 * Implemented from Alpaca's public documentation. Status: UNVERIFIED until run with
 * real keys (see Settings → Data providers → Test).
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

const TF: Record<string, string> = { "1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day", "1w": "1Week" };

export interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function parseAlpacaBars(bars: AlpacaBar[] | null | undefined): Bar[] {
  return (bars ?? []).map((b) => ({ time: Date.parse(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

/** Parse one WebSocket message (an array of events). */
export function parseAlpacaStream(raw: string): (
  | { kind: "bar"; symbol: string; bar: Bar }
  | { kind: "quote"; symbol: string; bid: number; ask: number; time: number }
  | { kind: "status"; message: string; ok: boolean }
)[] {
  const out: ReturnType<typeof parseAlpacaStream> = [];
  const events = JSON.parse(raw) as Record<string, unknown>[];
  for (const e of Array.isArray(events) ? events : []) {
    if (e.T === "b") out.push({ kind: "bar", symbol: String(e.S), bar: { time: Date.parse(String(e.t)), open: Number(e.o), high: Number(e.h), low: Number(e.l), close: Number(e.c), volume: Number(e.v) } });
    else if (e.T === "q" && Number(e.bp) > 0 && Number(e.ap) > 0) out.push({ kind: "quote", symbol: String(e.S), bid: Number(e.bp), ask: Number(e.ap), time: Date.parse(String(e.t)) });
    else if (e.T === "success") out.push({ kind: "status", message: String(e.msg), ok: true });
    else if (e.T === "error") out.push({ kind: "status", message: `${e.code}: ${e.msg}`, ok: false });
  }
  return out;
}

export class AlpacaProvider implements MarketDataProvider {
  readonly id = "alpaca" as const;
  readonly name = "Alpaca Market Data";
  private readonly http: RateLimitedFetcher;

  constructor(
    private readonly keyId = process.env.ALPACA_KEY_ID ?? "",
    private readonly secret = process.env.ALPACA_SECRET_KEY ?? "",
    private readonly feed = process.env.ALPACA_FEED || "iex",
    fetchImpl?: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.http = new RateLimitedFetcher({ minIntervalMs: 320, maxAttempts: 3, timeoutMs: 20_000, backoff429Ms: 3_000, fetchImpl });
  }

  private get configured() {
    return Boolean(this.keyId && this.secret);
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      name: this.name,
      assetClasses: ["stocks"],
      historical: true,
      live: true,
      timeframes: Object.keys(TF),
      bidAsk: { historical: false, live: true },
      priceBasis: "trade",
      liveKind: "quote",
      requiresCredentials: true,
      configured: this.configured,
      verification: "unverified",
      rateLimit: "200 requests/min on the free plan; 1 WebSocket connection.",
      licensing: "Requires free Alpaca keys; data use subject to Alpaca's terms and exchange rules.",
      notes: [
        this.feed === "iex"
          ? "IEX feed: real-time but covers only the IEX exchange (~2–3% of volume); prices/volume differ from the consolidated (SIP) tape."
          : `Feed: ${this.feed}`,
        "Historical bars are unadjusted (raw) for splits/dividends.",
        ...(this.configured ? [] : ["Not configured: set ALPACA_KEY_ID and ALPACA_SECRET_KEY in .env.local."]),
      ],
      delay: this.feed === "iex" ? "Real-time (IEX only)" : "Per feed",
    };
  }

  supports(symbol: string): boolean {
    const c = findCatalog(symbol);
    if (c) return Boolean(c.providers.alpaca);
    return /^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol.toUpperCase());
  }

  nativeSymbol(symbol: string): string {
    return symbol.toUpperCase();
  }

  private assertConfigured() {
    if (!this.configured) throw new ProviderUnavailableError("Alpaca is not configured (set ALPACA_KEY_ID and ALPACA_SECRET_KEY)");
  }

  private headers() {
    return { "APCA-API-KEY-ID": this.keyId, "APCA-API-SECRET-KEY": this.secret };
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo> {
    const c = findCatalog(symbol);
    return { symbol: symbol.toUpperCase(), baseAsset: symbol.toUpperCase(), quoteAsset: "USD", tickSize: c?.tickSize ?? 0.01, qtyStep: c?.qtyStep ?? 1, minQty: c?.minQty ?? 1, contractSize: 1 };
  }

  async checkStatus() {
    if (!this.configured) return { ok: false, message: "Not configured (needs ALPACA_KEY_ID and ALPACA_SECRET_KEY)", latencyMs: null };
    const t = Date.now();
    try {
      const res = await this.http.fetch(`https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&limit=1&feed=${this.feed}`, { headers: this.headers() });
      return { ok: res.ok, message: res.ok ? "Authenticated" : `HTTP ${res.status}`, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e), latencyMs: null };
    }
  }

  async fetchCandles(symbol: string, timeframe: string, from: number, to: number, opts: FetchOptions = {}): Promise<Bar[]> {
    this.assertConfigured();
    const tf = TF[timeframe];
    if (!tf) throw new MarketDataError(`Alpaca does not support timeframe ${timeframe}`);
    const out: Bar[] = [];
    let pageToken: string | null = null;
    let page = 0;
    do {
      opts.onProgress?.(page++, page + 1);
      const url: string =
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol.toUpperCase())}/bars?timeframe=${tf}` +
        `&start=${new Date(from).toISOString()}&end=${new Date(Math.min(to, this.now())).toISOString()}&limit=10000&adjustment=raw&feed=${this.feed}` +
        (pageToken ? `&page_token=${pageToken}` : "");
      const res = await this.http.fetch(url, { headers: this.headers() }, opts.signal);
      if (!res.ok) throw new MarketDataError(`Alpaca HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { bars: AlpacaBar[] | null; next_page_token: string | null };
      out.push(...parseAlpacaBars(data.bars));
      pageToken = data.next_page_token;
    } while (pageToken);
    return out.filter((b) => b.time >= from && b.time <= to);
  }

  async fetchRecent(symbol: string, timeframe: string, limit: number, endTime?: number): Promise<Bar[]> {
    const end = endTime ?? this.now();
    const days = timeframe === "1d" || timeframe === "1w" ? limit * 2 : Math.ceil(limit / 6) + 5;
    const bars = await this.fetchCandles(symbol, timeframe, end - days * 86_400_000, end);
    return bars.slice(-limit);
  }

  openStream(initial: StreamKey[], handlers: StreamHandlers): StreamConnection {
    let symbols = new Set(initial.map((k) => k.symbol));
    let ready = false;
    let closed = false;
    if (!this.configured) {
      queueMicrotask(() => handlers.onStatus("disconnected", "Alpaca not configured"));
      return { setStreams() {}, close() {} };
    }
    const ws = new WebSocket(`wss://stream.data.alpaca.markets/v2/${this.feed}`);
    const sub = (action: "subscribe" | "unsubscribe", list: string[]) =>
      list.length && ws.send(JSON.stringify({ action, quotes: list, bars: list }));
    handlers.onStatus("connecting");
    ws.onopen = () => ws.send(JSON.stringify({ action: "auth", key: this.keyId, secret: this.secret }));
    ws.onmessage = (ev) => {
      for (const e of parseAlpacaStream(String(ev.data))) {
        if (e.kind === "status") {
          if (!e.ok) handlers.onStatus("disconnected", e.message);
          else if (e.message === "authenticated") {
            ready = true;
            sub("subscribe", [...symbols]);
            handlers.onStatus("connected");
          }
        } else if (e.kind === "quote") handlers.onQuote?.({ symbol: e.symbol, bid: e.bid, ask: e.ask, time: e.time });
        else handlers.onCandle({ symbol: e.symbol, timeframe: "1m", bar: e.bar, closed: true, eventTime: e.bar.time + 60_000 });
      }
    };
    ws.onerror = () => handlers.onStatus("disconnected", "WebSocket error");
    ws.onclose = (ev) => {
      if (!closed) handlers.onStatus("disconnected", `closed (${ev.code})`);
    };
    return {
      setStreams(keys) {
        const next = new Set(keys.map((k) => k.symbol));
        if (ready) {
          sub("subscribe", [...next].filter((s) => !symbols.has(s)));
          sub("unsubscribe", [...symbols].filter((s) => !next.has(s)));
        }
        symbols = next;
      },
      close() {
        closed = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}

export const ALPACA_SYMBOLS = CATALOG.filter((c) => c.providers.alpaca).map((c) => c.symbol);
