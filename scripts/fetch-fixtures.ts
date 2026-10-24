/**
 * Downloads a fixed window of REAL Binance BTCUSDT candles into tests/fixtures so
 * the test suite runs offline and deterministically. Re-running produces identical
 * files because closed historical candles never change.
 *
 *   npm run fixtures
 */
import fs from "node:fs";
import path from "node:path";
import { BinanceProvider } from "../src/lib/market/binance";

const FROM = Date.UTC(2024, 2, 4, 0, 0); // 2024-03-04 00:00 UTC
const TO_1H = Date.UTC(2024, 2, 5, 23, 0); // 48 hourly bars
const TO_1M = Date.UTC(2024, 2, 5, 23, 59); // 2880 minute bars

async function main() {
  const p = new BinanceProvider();
  const out = path.resolve(__dirname, "../tests/fixtures");
  fs.mkdirSync(out, { recursive: true });
  const h1 = await p.fetchCandles("BTCUSDT", "1h", FROM, TO_1H);
  const m1 = await p.fetchCandles("BTCUSDT", "1m", FROM, TO_1M);
  const compact = (bars: typeof h1) => bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]);
  fs.writeFileSync(path.join(out, "btcusdt-1h-2024-03-04.json"), JSON.stringify(compact(h1)));
  fs.writeFileSync(path.join(out, "btcusdt-1m-2024-03-04.json"), JSON.stringify(compact(m1)));
  const info = await p.symbolInfo("BTCUSDT");
  fs.writeFileSync(path.join(out, "btcusdt-info.json"), JSON.stringify(info, null, 2));
  console.log(`1h: ${h1.length} bars, 1m: ${m1.length} bars`, info);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
