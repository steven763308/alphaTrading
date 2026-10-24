import type { Bar } from "@/lib/engine/types";
import type { CandleUpdate, MarketDataProvider, StreamHandlers, StreamKey, SymbolInfo } from "@/lib/market/provider";
import { BTC, H1, M1 } from "./helpers";

/** Serves fixture candles; optionally exposes a controllable stream. */
export class FakeProvider implements MarketDataProvider {
  readonly id = "binance";
  readonly name = "Fake Binance (fixtures)";
  data: Record<string, Bar[]> = { "1h": H1, "1m": M1 };
  fetchCalls = 0;
  failRest = false;
  handlers: StreamHandlers | null = null;
  streams: StreamKey[] = [];
  opened = 0;

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
    return { ...BTC, symbol, baseAsset: "BTC", quoteAsset: "USDT" };
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
}
