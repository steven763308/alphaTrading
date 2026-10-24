import { randomUUID } from "node:crypto";
import type { Bar, Conversion, InstrumentSpec } from "@/lib/engine/types";
import { aggregateBars } from "@/lib/market/aggregate";
import { AlpacaProvider } from "@/lib/market/alpaca";
import { BinanceProvider } from "@/lib/market/binance";
import { CATALOG, findCatalog, normalizeCurrency, type ProviderId } from "@/lib/market/catalog";
import { DukascopyProvider } from "@/lib/market/dukascopy";
import { OandaProvider } from "@/lib/market/oanda";
import { ProviderUnavailableError, type MarketDataProvider, type ProviderCapabilities } from "@/lib/market/provider";
import { timeframeMs } from "@/lib/market/timeframes";
import type { Db } from "../db/client";
import {
  addCoverage,
  getCandleRange,
  getInstrument,
  getOrCreateDataset,
  insertCandles,
  instrumentId,
  LIVE_CACHE_LABEL,
  setDatasetMeta,
  uncoveredRanges,
  upsertInstrument,
  type InstrumentRow,
} from "../repo/market";

// ---------------------------------------------------------------- registry

const g = globalThis as unknown as { __tradelabProviders?: Map<string, MarketDataProvider> };

function registry(): Map<string, MarketDataProvider> {
  if (!g.__tradelabProviders) {
    g.__tradelabProviders = new Map<string, MarketDataProvider>([
      ["binance", new BinanceProvider()],
      ["dukascopy", new DukascopyProvider()],
      ["oanda", new OandaProvider()],
      ["alpaca", new AlpacaProvider()],
    ]);
  }
  return g.__tradelabProviders;
}

export function getProvider(id: string): MarketDataProvider {
  const p = registry().get(id);
  if (!p) throw new ProviderUnavailableError(`Unknown market data provider ${id}`);
  return p;
}

/** Test hook: replace a provider (e.g. with a fixture-backed fake). */
export function setProvider(id: string, provider: MarketDataProvider) {
  registry().set(id, provider);
}

/** CSV import isn't a fetchable provider, but is listed for completeness. */
export const CSV_CAPABILITIES: ProviderCapabilities = {
  id: "csv",
  name: "Universal CSV import",
  assetClasses: ["crypto", "forex", "metals", "stocks", "indices", "futures", "commodities", "custom"],
  historical: true,
  live: false,
  timeframes: ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"],
  bidAsk: { historical: false, live: false },
  priceBasis: "trade",
  liveKind: null,
  requiresCredentials: false,
  configured: true,
  verification: "verified",
  rateLimit: "Local files",
  licensing: "Your responsibility — import only data you are licensed to use.",
  notes: ["Any market; contract specs are set at import.", "Each import is an immutable dataset; gaps are reported, never filled."],
  delay: "Historical only",
};

export function listProviders(): ProviderCapabilities[] {
  return [...[...registry().values()].map((p) => p.capabilities()), CSV_CAPABILITIES];
}

export type DataMode = "historical" | "live";

const PREFERENCE: Record<DataMode, ProviderId[]> = {
  historical: ["binance", "dukascopy", "oanda", "alpaca"],
  live: ["binance", "oanda", "alpaca"],
};

export interface Availability {
  provider: ProviderId | null;
  /** Every provider that could serve the symbol in this mode, configured or not. */
  candidates: { id: ProviderId; configured: boolean; verification: string }[];
  reason: string | null;
}

/** Pick a provider for a symbol, or explain clearly why none is available. */
export function resolveProvider(symbol: string, mode: DataMode, preferred?: string): Availability {
  const s = symbol.toUpperCase();
  const all = PREFERENCE[mode]
    .map((id) => getProvider(id))
    .filter((p) => p.supports(s) && (mode === "live" ? p.capabilities().live : p.capabilities().historical));
  const candidates = all.map((p) => ({ id: p.id, configured: p.capabilities().configured, verification: p.capabilities().verification }));
  const ready = all.filter((p) => p.capabilities().configured);
  const pick = (preferred && ready.find((p) => p.id === preferred)) || ready[0];
  if (pick) return { provider: pick.id, candidates, reason: null };
  if (all.length) {
    const names = all.map((p) => p.capabilities().name).join(" or ");
    return { provider: null, candidates, reason: `${mode === "live" ? "Live" : "Historical"} data for ${s} needs ${names} — not configured. ${all[0].capabilities().notes.find((n) => n.startsWith("Not configured")) ?? ""}`.trim() };
  }
  const cat = findCatalog(s);
  return {
    provider: null,
    candidates,
    reason:
      mode === "live"
        ? `No live data source supports ${s}${cat?.providers.dukascopy ? " (Dukascopy is historical-only; configure OANDA for live FX/metals)" : ""}. No delayed or substitute data is used.`
        : `No historical data source supports ${s}. Import a CSV instead.`,
  };
}

// ---------------------------------------------------------------- instruments

export function specOf(i: InstrumentRow, leverageOverride?: number | null): InstrumentSpec {
  return {
    symbol: i.symbol,
    tickSize: i.tickSize,
    qtyStep: i.qtyStep,
    minQty: i.minQty,
    contractSize: i.contractSize,
    leverage: leverageOverride ?? i.leverage,
    financing: i.financing ?? undefined,
  };
}

export async function ensureInstrument(db: Db, sourceId: string, symbol: string): Promise<InstrumentRow> {
  const sym = symbol.toUpperCase();
  const existing = getInstrument(db, instrumentId(sourceId, sym));
  const cat = findCatalog(sym);
  if (existing && (!cat || existing.calendar === cat.calendar)) return existing;
  if (sourceId === "csv") {
    if (existing) return existing;
    throw new ProviderUnavailableError(`Unknown CSV instrument ${sym}`);
  }
  const provider = getProvider(sourceId);
  if (!provider.supports(sym)) throw new ProviderUnavailableError(`${provider.name} does not provide ${sym}`);
  const info = await provider.symbolInfo(sym);
  return upsertInstrument(db, sourceId, info, cat?.assetClass ?? "crypto", {
    displayName: cat?.name ?? null,
    unit: cat?.unit ?? "coin",
    leverage: cat?.leverage ?? 1,
    calendar: cat?.calendar ?? "24x7",
    timeZone: cat?.timeZone ?? "UTC",
    financing: cat?.financing ?? null,
    providerSymbol: provider.nativeSymbol(sym),
  });
}

// ---------------------------------------------------------------- downloads

export interface DownloadProgress {
  done: number;
  total: number;
}

/**
 * Make sure the provider cache dataset holds closed candles for [from, to].
 * Incremental: only ranges never fetched before are requested (known gaps such as
 * weekends are remembered in dataset_coverage). Timeframes a provider builds from a
 * base resolution (Dukascopy 15m ← 1m) download the base once and aggregate locally.
 */
export async function ensureProviderRange(
  db: Db,
  instrument: InstrumentRow,
  timeframe: string,
  from: number,
  to: number,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ datasetId: number; fetched: number }> {
  const provider = getProvider(instrument.sourceId);
  const caps = provider.capabilities();
  const ds = getOrCreateDataset(db, instrument.sourceId, instrument.id, timeframe, LIVE_CACHE_LABEL);
  setDatasetMeta(db, ds.id, caps.priceBasis, { provider: caps.id, delay: caps.delay, licensing: caps.licensing, bidAsk: caps.bidAsk.historical });
  const step = timeframeMs(timeframe);
  const published = (provider as { publishedUntil?: () => number }).publishedUntil?.() ?? Date.now();
  const lastClosed = Math.floor((Math.min(Date.now(), published) - step) / step) * step;
  const end = Math.min(to, lastClosed);
  if (end < from) return { datasetId: ds.id, fetched: 0 };

  const base = provider.baseTimeframe?.(timeframe);
  let fetched = 0;
  if (base) {
    // Fill the base dataset first, then aggregate into this timeframe.
    const r = await ensureProviderRange(db, instrument, base, from, end + step - timeframeMs(base), onProgress, signal);
    for (const [a, b] of uncoveredRanges(db, ds.id, from, end, step)) {
      const baseBars = getCandleRange(db, r.datasetId, a, b + step - 1);
      fetched += insertCandles(db, ds.id, aggregateBars(baseBars, timeframe).filter((x) => x.time >= a && x.time <= b));
      addCoverage(db, ds.id, a, b, step);
    }
    return { datasetId: ds.id, fetched };
  }

  const ranges = uncoveredRanges(db, ds.id, from, end, step);
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    const bars = await provider.fetchCandles(instrument.symbol, timeframe, a, b, {
      signal,
      onProgress: (d, t) => onProgress?.({ done: i + d / Math.max(t, 1), total: ranges.length }),
    });
    fetched += insertCandles(db, ds.id, bars);
    addCoverage(db, ds.id, a, b, step);
  }
  onProgress?.({ done: ranges.length, total: ranges.length });
  return { datasetId: ds.id, fetched };
}

/** @deprecated name kept for older call sites. */
export const ensureExchangeRange = ensureProviderRange;

export interface DownloadJob {
  id: string;
  key: string;
  symbol: string;
  provider: string;
  timeframe: string;
  from: number;
  to: number;
  status: "running" | "done" | "error";
  progress: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const jobs = (globalThis as unknown as { __tradelabJobs?: Map<string, DownloadJob> }).__tradelabJobs ?? new Map<string, DownloadJob>();
(globalThis as unknown as { __tradelabJobs?: Map<string, DownloadJob> }).__tradelabJobs = jobs;

/**
 * Start (or join) a background download so long, rate-limited downloads don't hold
 * an HTTP request open. Poll with getDownloadJob().
 */
export function startDownload(db: Db, input: { provider: string; symbol: string; timeframe: string; from: number; to: number; warmupBars?: number }): DownloadJob {
  const key = `${input.provider}:${input.symbol}:${input.timeframe}:${input.from}:${input.to}`;
  const running = [...jobs.values()].find((j) => j.key === key && j.status === "running");
  if (running) return running;
  const job: DownloadJob = {
    id: randomUUID(),
    key,
    symbol: input.symbol.toUpperCase(),
    provider: input.provider,
    timeframe: input.timeframe,
    from: input.from,
    to: input.to,
    status: "running",
    progress: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  (async () => {
    try {
      const inst = await ensureInstrument(db, input.provider, input.symbol);
      const warm = (input.warmupBars ?? 0) * timeframeMs(input.timeframe);
      await ensureProviderRange(db, inst, input.timeframe, input.from - warm, input.to, (p) => {
        job.progress = p.total ? Math.min(0.99, p.done / p.total) : 0;
      });
      const conv = conversionPair(inst, "USD");
      if (conv?.pair) {
        const pairInst = await ensureInstrument(db, input.provider, conv.pair);
        await ensureProviderRange(db, pairInst, input.timeframe, input.from - warm, input.to);
      }
      job.progress = 1;
      job.status = "done";
    } catch (e) {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}

export function getDownloadJob(id: string): DownloadJob | undefined {
  return jobs.get(id);
}

// ---------------------------------------------------------------- conversion

/**
 * How to convert this instrument's quote currency into the account currency.
 * Returns the kind plus, for crosses, the conversion pair symbol (and whether its
 * price must be inverted). Null when no conversion route exists.
 */
export function conversionPair(
  instrument: Pick<InstrumentRow, "symbol" | "baseAsset" | "quoteAsset">,
  accountCurrency: string,
): { kind: Conversion["kind"]; pair?: string; invert?: boolean } | null {
  const acct = normalizeCurrency(accountCurrency);
  const quote = normalizeCurrency(instrument.quoteAsset ?? "");
  const base = normalizeCurrency(instrument.baseAsset ?? "");
  if (!quote || quote === acct) return { kind: "identity" };
  if (base === acct) return { kind: "inverse" };
  const direct = CATALOG.find((c) => c.symbol === `${quote}${acct}`);
  if (direct) return { kind: "rate", pair: direct.symbol, invert: false };
  const inverse = CATALOG.find((c) => c.symbol === `${acct}${quote}`);
  if (inverse) return { kind: "rate", pair: inverse.symbol, invert: true };
  return null;
}

/** Latest close at or before `time` from an ascending series → quote→account rate. */
export function rateAt(series: Bar[], time: number, invert: boolean): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let found: Bar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].time <= time) {
      found = series[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!found || !(found.close > 0)) return null;
  return invert ? 1 / found.close : found.close;
}

/**
 * Lower-timeframe (1m) candles covering one higher-timeframe bar, used to resolve
 * intrabar SL/TP ordering. Returns null when unavailable (CSV data, provider error,
 * incomplete coverage, or a provider where per-bar downloads would be too slow).
 */
export async function lowerTimeframeBars(db: Db, instrument: InstrumentRow, bar: Bar, timeframe: string): Promise<Bar[] | null> {
  if (instrument.sourceId === "csv" || timeframe === "1m") return null;
  const from = bar.time;
  const to = bar.time + timeframeMs(timeframe) - 60_000;
  try {
    const { datasetId } = await ensureProviderRange(db, instrument, "1m", from, to);
    const subs = getCandleRange(db, datasetId, from, to);
    const expected = timeframeMs(timeframe) / 60_000;
    // Partial coverage could hide the real path: only use complete minute data.
    // Markets with closed periods (FX/stocks) rarely have complete minutes, so they
    // fall back to the conservative rule — which is the safe direction.
    return subs.length === expected ? subs : null;
  } catch {
    return null;
  }
}
