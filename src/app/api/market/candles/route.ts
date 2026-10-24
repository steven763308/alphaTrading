import { getDb } from "@/lib/server/db/client";
import { json, query, route } from "@/lib/server/http";
import { isTimeframe } from "@/lib/market/timeframes";
import { getProvider } from "@/lib/server/services/market-data";
import { liveInstrument } from "@/lib/server/services/live";
import { EngineError } from "@/lib/engine/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Recent candles for the live chart from the instrument's live provider (includes the forming bar). */
export const GET = route(async (req: Request) => {
  const q = query(req);
  const symbol = (q.get("symbol") || "").toUpperCase();
  const tf = q.get("tf") || "";
  if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !isTimeframe(tf)) throw new EngineError("Invalid symbol or timeframe");
  const inst = await liveInstrument(getDb(), symbol, q.get("provider") || undefined);
  const limit = Math.min(Number(q.get("limit") || 500), 1000);
  const endTime = q.get("endTime") ? Number(q.get("endTime")) : undefined;
  return json(await getProvider(inst.sourceId).fetchRecent(inst.symbol, tf, limit, endTime));
});
