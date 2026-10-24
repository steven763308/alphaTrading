import { getDb } from "@/lib/server/db/client";
import { json, query, route } from "@/lib/server/http";
import { getVisibleCandles } from "@/lib/server/services/backtest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/** Candles up to the replay cursor only (future candles are never served). */
export const GET = route(async (req: Request, ctx: Ctx) => {
  const q = query(req);
  const before = q.get("before") ? Number(q.get("before")) : undefined;
  const limit = q.get("limit") ? Number(q.get("limit")) : 1000;
  return json(getVisibleCandles(getDb(), (await ctx.params).id, { before, limit }));
});
