import type { Bar } from "@/lib/engine/types";
import type { ProviderId } from "@/lib/market/catalog";
import type { CandleUpdate, MarketDataProvider, ProviderCapabilities, QuoteUpdate, StreamHandlers, StreamKey, SymbolInfo } from "@/lib/market/provider";
import { BTC, H1, M1 } from "./helpers";

/** Serves fixture candles; optionally exposes a controllable stream. */
export class FakeProvider implements MarketDataProvider {
  readonly name: string;
  data: Record<string, Bar[]> = { "1h": H1, "1m": M1 };
  fetchCalls = 0;
  failRest = false;
  handlers: StreamHandlers | null = null;
  streams: StreamKey[] = [];
  opened = 0;
  info: SymbolInfo = { ...BTC, baseAsset: "BTC", quoteAsset: "USDT" };

  constructor(
    readonly id: ProviderId = "binance",
    private readonly liveKind: "kline" | "quote" = "kline",
    private readonly base?: Record<string, string>,
  ) {
    this.name = `Fake ${id}`;
  }

  capabilities(): ProviderCapabilities {
    return {
      id: this.id,
      name: this.name,
      assetClasses: ["crypto", "forex", "metals", "stocks"],
      historical: true,
      live: true,
      timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"],
      bidAsk: { historical: false, live: this.liveKind === "quote" },
      priceBasis: "trade",
      liveKind: this.liveKind,
      requiresCredentials: false,
      configured: true,
      verification: "verified",
      rateLimit: "n/a",
      licensing: "test fixtures",
      notes: [],
      delay: "n/a",
    };
  }

  supports(): boolean {
    return true;
  }

  nativeSymbol(symbol: string): string {
    return symbol.toUpperCase();
  }

  baseTimeframe(tf: string): string | undefined {
    return this.base?.[tf];
  }

  async checkStatus() {
    return { ok: true, message: "fake", latencyMs: 0 };
  }

  async fetchCandles(_symbol: string, timeframe: string, from: number, to: number): Promise<Bar[]> {
    this.fetchCalls++;
    if (this.failRest) throw new Error("network down");
    return (this.data[timeframe] ?? []).filter((b) => b.time >= from && b.time <= to);
  }

  async fetchRecent(_symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
    if (this.failRest) throw new Error("network down");
    return (this.data[`${timeframe}:recent`] ?? []).slice(-limit);
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo> {
    return { ...this.info, symbol };
  }

  openStream(initial: StreamKey[], handlers: StreamHandlers) {
    this.opened++;
    this.handlers = handlers;
    this.streams = initial;
    return {
      setStreams: (s: StreamKey[]) => {
        this.streams = s;
      },
      close: () => {
        this.handlers = null;
      },
    };
  }

  emit(u: Partial<CandleUpdate> & { bar: Bar; eventTime: number }) {
    this.handlers?.onCandle({ symbol: "BTCUSDT", timeframe: "1m", closed: false, ...u });
  }

  quote(q: QuoteUpdate) {
    this.handlers?.onQuote?.(q);
  }
}
