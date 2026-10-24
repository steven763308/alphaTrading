import type { Bar } from "@/lib/engine/types";
import type { AssetClass, ProviderId } from "./catalog";

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  qtyStep: number;
  minQty: number;
  contractSize: number;
}

/** A streamed candle update. `closed` is true once the bar is final. */
export interface CandleUpdate {
  /** Provider-native symbol (mapped back to the instrument by the feed). */
  symbol: string;
  timeframe: string;
  bar: Bar;
  closed: boolean;
  /** Source event time (UTC ms). */
  eventTime: number;
}

/** A streamed top-of-book quote. */
export interface QuoteUpdate {
  symbol: string;
  bid: number;
  ask: number;
  /** Source timestamp (UTC ms). */
  time: number;
}

export type StreamStatus = "connecting" | "connected" | "disconnected";

export interface StreamKey {
  /** Provider-native symbol. */
  symbol: string;
  timeframe: string;
}

/** A live stream connection whose stream set can change. */
export interface StreamConnection {
  setStreams(streams: StreamKey[]): void;
  close(): void;
}

export interface StreamHandlers {
  onCandle(update: CandleUpdate): void;
  onQuote?(update: QuoteUpdate): void;
  onStatus(status: StreamStatus, detail?: string): void;
}

export type PriceBasis = "trade" | "mid" | "bid" | "ask";

/** What a provider can do, for UI status and routing. */
export interface ProviderCapabilities {
  id: ProviderId;
  name: string;
  assetClasses: AssetClass[];
  historical: boolean;
  live: boolean;
  timeframes: string[];
  /** Whether bid/ask (spread) is available historically and/or live. */
  bidAsk: { historical: boolean; live: boolean };
  priceBasis: PriceBasis;
  /** Live updates arrive as cumulative klines or as quotes. */
  liveKind: "kline" | "quote" | null;
  requiresCredentials: boolean;
  /** Credentials present (or none needed). */
  configured: boolean;
  /**
   * "verified" = exercised end-to-end against the real service in this build;
   * "unverified" = implemented from the provider's documentation but not yet run
   * with real credentials. Do not treat unverified adapters as production-ready.
   */
  verification: "verified" | "unverified";
  rateLimit: string;
  licensing: string;
  notes: string[];
  /** Free-text data delay disclosure ("real-time", "IEX-only real-time", …). */
  delay: string;
}

export interface FetchOptions {
  /** Called as files/pages complete: done, total (total may be an estimate). */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Extensible market data provider. Implementations must return REAL market data —
 * never synthesized prices. Missing data is reported as missing (gaps), not filled.
 */
export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly name: string;
  capabilities(): ProviderCapabilities;
  /** True if this provider serves the (TradeLab) symbol. */
  supports(symbol: string): boolean;
  /** Closed candles with open time in [from, to], ascending. Bars may carry `spread`. */
  fetchCandles(symbol: string, timeframe: string, from: number, to: number, opts?: FetchOptions): Promise<Bar[]>;
  /** The most recent `limit` candles ending at or before `endTime` (may include the forming bar). */
  fetchRecent(symbol: string, timeframe: string, limit: number, endTime?: number): Promise<Bar[]>;
  symbolInfo(symbol: string): Promise<SymbolInfo>;
  /** Live stream (where supported). Reconnection is the caller's job. */
  openStream?(initial: StreamKey[], handlers: StreamHandlers): StreamConnection;
  /** Provider-native symbol for a TradeLab symbol. */
  nativeSymbol(symbol: string): string;
  /** Quick connectivity / credential check. */
  checkStatus(): Promise<{ ok: boolean; message: string; latencyMs: number | null }>;
  /**
   * For providers whose files come in a few base resolutions: the base timeframe to
   * download and aggregate from (e.g. Dukascopy 15m ← 1m). Undefined = native.
   */
  baseTimeframe?(timeframe: string): string | undefined;
  /** Optional download chunking at the provider's file boundaries (progress is saved per chunk). */
  chunkRanges?(from: number, to: number, timeframe: string): [number, number][];
}

export class MarketDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MarketDataError";
  }
}

export class ProviderUnavailableError extends MarketDataError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
