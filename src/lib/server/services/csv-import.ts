import { EngineError } from "@/lib/engine/types";
import { parseOhlcvCsv } from "@/lib/market/csv";
import { isTimeframe, timeframeMs } from "@/lib/market/timeframes";
import type { Db } from "../db/client";
import { countGaps, getDataset, getOrCreateDataset, insertCandles, upsertInstrument } from "../repo/market";

export interface CsvImportInput {
  symbol: string;
  timeframe: string;
  text: string;
  label?: string;
  market?: string;
  tickSize?: number;
  qtyStep?: number;
  minQty?: number;
  contractSize?: number;
}

/**
 * Import real OHLCV data from a CSV file into a new, immutable dataset. Each import
 * gets its own label so re-imports never silently change existing sessions.
 */
export function importCsv(db: Db, input: CsvImportInput) {
  if (!isTimeframe(input.timeframe)) throw new EngineError(`Unsupported timeframe ${input.timeframe}`);
  const symbol = input.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9._-]{2,30}$/.test(symbol)) throw new EngineError("Symbol must be 2–30 letters/digits");
  const step = timeframeMs(input.timeframe);
  const parsed = parseOhlcvCsv(input.text, step);
  if (parsed.bars.length === 0) throw new EngineError(parsed.errors[0] ?? "No valid candles found");
  const misaligned = parsed.bars.filter((b) => b.time % step !== 0 && !input.timeframe.endsWith("w")).length;
  if (misaligned > parsed.bars.length / 2) {
    throw new EngineError(`Most timestamps are not aligned to ${input.timeframe} bar opens. Check the timeframe or time column.`);
  }

  const instrument = upsertInstrument(
    db,
    "csv",
    {
      symbol,
      baseAsset: symbol,
      quoteAsset: "",
      tickSize: input.tickSize ?? inferTick(parsed.bars.map((b) => b.close)),
      qtyStep: input.qtyStep ?? 0.0001,
      minQty: input.minQty ?? input.qtyStep ?? 0.0001,
      contractSize: input.contractSize ?? 1,
    },
    input.market ?? "custom",
  );
  const label = input.label?.trim() || `import-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const ds = getOrCreateDataset(db, "csv", instrument.id, input.timeframe, label);
  if (ds.candleCount > 0) throw new EngineError(`A CSV dataset labelled "${label}" already exists; datasets are immutable`);
  const inserted = insertCandles(db, ds.id, parsed.bars);
  return {
    dataset: getDataset(db, ds.id)!,
    instrument,
    inserted,
    duplicates: parsed.duplicates,
    gaps: countGaps(parsed.bars, step),
    errors: parsed.errors,
  };
}

/** Smallest decimal increment visible in the prices (capped at 8 decimals). */
function inferTick(prices: number[]): number {
  let decimals = 0;
  for (const p of prices.slice(0, 500)) {
    const d = (String(p).split(".")[1] ?? "").length;
    decimals = Math.max(decimals, Math.min(d, 8));
  }
  return Number((10 ** -decimals).toFixed(decimals));
}
