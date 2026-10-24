import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { listDatasets } from "@/lib/server/repo/market";
import { importCsv } from "@/lib/server/services/csv-import";
import { csvImportSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(() => json(listDatasets(getDb())));

/** Import a CSV of real OHLCV candles as a new immutable dataset. */
export const POST = route(async (req: Request) => {
  const input = await body(req, csvImportSchema);
  return json(importCsv(getDb(), input), { status: 201 });
});
