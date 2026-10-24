// Decodes the bundled real XAUUSD fixture files and prints a summary (manual check).
import fs from "node:fs";
import path from "node:path";
import { decodeCandleFile, mergeBidAsk } from "../src/lib/market/dukascopy";

const dir = path.resolve(__dirname, "../tests/fixtures/dukascopy");
const start = Date.UTC(2024, 1, 1); // month index 01 = February
const bid = decodeCandleFile(fs.readFileSync(path.join(dir, "XAUUSD_2024_01_BID_candles_hour_1.bi5")), start, 1000);
const ask = decodeCandleFile(fs.readFileSync(path.join(dir, "XAUUSD_2024_01_ASK_candles_hour_1.bi5")), start, 1000);
const mid = mergeBidAsk(bid, ask, 3);
console.log({ bid: bid.length, ask: ask.length, trading: mid.length });
console.log(mid.slice(0, 3).map((b) => ({ t: new Date(b.time).toISOString(), ...b })));
const spreads = mid.map((b) => b.spread!).sort((a, b) => a - b);
console.log("median spread", spreads[Math.floor(spreads.length / 2)], "max", spreads[spreads.length - 1]);
