export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function timeframeMs(tf: string): number {
  const m = /^(\d+)([mhdw])$/.exec(tf);
  if (!m) throw new Error(`Unsupported timeframe ${tf}`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

export function isTimeframe(tf: string): tf is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(tf);
}

/** Floor a timestamp to the start of its bar. Weekly bars start Monday 00:00 UTC (Binance convention). */
export function barStart(time: number, tf: string): number {
  const ms = timeframeMs(tf);
  if (tf.endsWith("w")) {
    const mondayOffset = 4 * 86_400_000; // 1970-01-01 was a Thursday.
    return Math.floor((time - mondayOffset) / ms) * ms + mondayOffset;
  }
  return Math.floor(time / ms) * ms;
}
