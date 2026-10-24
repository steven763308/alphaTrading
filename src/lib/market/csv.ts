import type { Bar } from "@/lib/engine/types";

export interface CsvParseResult {
  bars: Bar[];
  errors: string[];
  duplicates: number;
  /** Count of missing intervals between consecutive bars (not filled). */
  gaps: number;
}

const TIME_KEYS = ["time", "timestamp", "date", "datetime", "open_time", "opentime"];

function parseTime(raw: string): number | null {
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    // Heuristic: seconds vs milliseconds vs microseconds.
    if (n < 1e11) return Math.round(n * 1000);
    if (n > 1e14) return Math.round(n / 1000);
    return Math.round(n);
  }
  // Treat timestamps without an explicit zone as UTC.
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Parse OHLCV CSV. Accepts a header row with time/open/high/low/close[/volume]
 * columns (any order, case-insensitive), or headerless Binance kline dumps
 * (open_time, open, high, low, close, volume, ...).
 */
export function parseOhlcvCsv(text: string, timeframeMs?: number): CsvParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const errors: string[] = [];
  if (lines.length === 0) return { bars: [], errors: ["File is empty"], duplicates: 0, gaps: 0 };

  const delim = lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const first = lines[0].split(delim).map((c) => c.trim().toLowerCase().replace(/"/g, ""));
  const hasHeader = first.some((c) => /[a-z]/.test(c) && !/^\d/.test(c));

  let idx = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
  if (hasHeader) {
    const find = (names: string[]) => first.findIndex((c) => names.includes(c));
    idx = {
      time: find(TIME_KEYS),
      open: find(["open", "o"]),
      high: find(["high", "h"]),
      low: find(["low", "l"]),
      close: find(["close", "c"]),
      volume: find(["volume", "vol", "v"]),
    };
    const missing = (["time", "open", "high", "low", "close"] as const).filter((k) => idx[k] < 0);
    if (missing.length) return { bars: [], errors: [`Missing column(s): ${missing.join(", ")}`], duplicates: 0, gaps: 0 };
  }

  const byTime = new Map<number, Bar>();
  let duplicates = 0;
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cells = lines[i].split(delim).map((c) => c.trim().replace(/"/g, ""));
    const time = parseTime(cells[idx.time] ?? "");
    const bar: Bar = {
      time: time ?? NaN,
      open: Number(cells[idx.open]),
      high: Number(cells[idx.high]),
      low: Number(cells[idx.low]),
      close: Number(cells[idx.close]),
      volume: idx.volume >= 0 ? Number(cells[idx.volume] ?? 0) || 0 : 0,
    };
    const nums = [bar.open, bar.high, bar.low, bar.close];
    if (time == null || nums.some((n) => !Number.isFinite(n) || n <= 0)) {
      if (errors.length < 20) errors.push(`Line ${i + 1}: invalid values`);
      continue;
    }
    if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high) {
      if (errors.length < 20) errors.push(`Line ${i + 1}: high/low inconsistent with open/close`);
      continue;
    }
    if (byTime.has(bar.time)) duplicates++;
    byTime.set(bar.time, bar);
  }

  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  let gaps = 0;
  if (timeframeMs) {
    for (let i = 1; i < bars.length; i++) {
      const missing = Math.round((bars[i].time - bars[i - 1].time) / timeframeMs) - 1;
      if (missing > 0) gaps += missing;
    }
  }
  return { bars, errors, duplicates, gaps };
}
