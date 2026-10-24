import fs from "node:fs";
import path from "node:path";

const FIX = path.join(__dirname, "fixtures", "dukascopy");

/** Serves the bundled real Dukascopy files; every other path is a 404 (no data). */
export function dukascopyFixtureFetch(calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const m = /datafeed\/XAUUSD\/2024\/01\/(BID|ASK)_candles_hour_1\.bi5$/.exec(url);
    if (!m) return new Response(null, { status: 404 });
    return new Response(fs.readFileSync(path.join(FIX, `XAUUSD_2024_01_${m[1]}_candles_hour_1.bi5`)), { status: 200 });
  }) as typeof fetch;
}

