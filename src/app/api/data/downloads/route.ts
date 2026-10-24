import { z } from "zod";
import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { WARMUP_BARS } from "@/lib/server/services/backtest";
import { resolveProvider, startDownload } from "@/lib/server/services/market-data";
import { timeframeSchema } from "@/lib/server/validation";
import { EngineError } from "@/lib/engine/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Start (or join) a background download of historical candles, so slow, rate-limited
 * providers can show progress. Poll GET /api/data/downloads/:id.
 */
export const POST = route(async (req: Request) => {
  const input = await body(
    req,
    z.object({ symbol: z.string().trim().toUpperCase(), provider: z.string().default("auto"), timeframe: timeframeSchema, from: z.number().int(), to: z.number().int() }),
  );
  const avail = resolveProvider(input.symbol, "historical", input.provider === "auto" ? undefined : input.provider);
  if (!avail.provider) throw new EngineError(avail.reason ?? "No historical data source");
  return json(startDownload(getDb(), { ...input, provider: avail.provider, warmupBars: WARMUP_BARS }), { status: 202 });
});
