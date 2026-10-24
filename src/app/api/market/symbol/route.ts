import { getDb } from "@/lib/server/db/client";
import { json, query, route } from "@/lib/server/http";
import { ensureInstrument } from "@/lib/server/services/market-data";
import { EngineError } from "@/lib/engine/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Validate a Binance symbol and return its contract specification. */
export const GET = route(async (req: Request) => {
  const symbol = (query(req).get("symbol") || "").toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw new EngineError("Invalid symbol");
  return json(await ensureInstrument(getDb(), "binance", symbol));
});
