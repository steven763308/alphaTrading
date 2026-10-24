import type { Bar } from "@/lib/engine/types";
import { barStart, timeframeMs } from "./timeframes";

/**
 * Aggregate ascending base bars into a higher timeframe (UTC-aligned buckets).
 * Only complete-by-time buckets are emitted when `until` is given (bucket end <= until).
 * The spread of an aggregated bar is the spread of its last base bar (closest to the close).
 */
export function aggregateBars(bars: Bar[], timeframe: string, until?: number): Bar[] {
  const out: Bar[] = [];
  const step = timeframeMs(timeframe);
  let cur: Bar | null = null;
  for (const b of bars) {
    const t = barStart(b.time, timeframe);
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, ...(b.spread != null ? { spread: b.spread } : {}) };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
      if (b.spread != null) cur.spread = b.spread;
    }
  }
  if (cur) out.push(cur);
  return until == null ? out : out.filter((b) => b.time + step <= until);
}
