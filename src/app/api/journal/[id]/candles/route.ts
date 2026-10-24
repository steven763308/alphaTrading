import { eq } from "drizzle-orm";
import { timeframeMs } from "@/lib/market/timeframes";
import { getDb } from "@/lib/server/db/client";
import { backtestSessions, tradeJournal } from "@/lib/server/db/schema";
import { json, route } from "@/lib/server/http";
import { getCandleRange } from "@/lib/server/repo/market";
import { NotFoundError } from "@/lib/server/services/backtest";
import { getProvider } from "@/lib/server/services/market-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Candles around a trade for review/annotation. Backtest trades read from the
 * session's dataset and never past its replay cursor (no peeking ahead).
 */
export const GET = route(async (_req: Request, ctx: Ctx) => {
  const db = getDb();
  const row = db.select().from(tradeJournal).where(eq(tradeJournal.id, Number((await ctx.params).id))).get();
  if (!row) throw new NotFoundError("Journal entry not found");
  const step = timeframeMs(row.timeframe);
  const from = row.entryTime - 80 * step;
  let to = row.exitTime + 30 * step;
  if (row.sessionId) {
    const s = db.select().from(backtestSessions).where(eq(backtestSessions.id, row.sessionId)).get();
    if (!s) return json([]);
    to = Math.min(to, s.cursorTime);
    return json(getCandleRange(db, s.datasetId, from, to));
  }
  to = Math.min(to, Date.now());
  const bars = await getProvider("binance").fetchCandles(row.symbol, row.timeframe, from, to);
  return json(bars.slice(-1000));
});
