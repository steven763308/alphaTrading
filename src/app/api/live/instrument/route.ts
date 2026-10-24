import { getDb } from "@/lib/server/db/client";
import { json, query, route } from "@/lib/server/http";
import { liveInstrumentInfo } from "@/lib/server/services/live";
import { EngineError } from "@/lib/engine/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Live availability + spec for a symbol. `available: false` carries the reason. */
export const GET = route(async (req: Request) => {
  const symbol = (query(req).get("symbol") || "").toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw new EngineError("Invalid symbol");
  return json(await liveInstrumentInfo(getDb(), symbol));
});
