import { buildReport } from "@/lib/analytics/metrics";
import { getDb } from "@/lib/server/db/client";
import { json, query, route } from "@/lib/server/http";
import { journalTradeRecords } from "@/lib/server/repo/journal";
import { getSettings } from "@/lib/server/repo/settings";
import { parseJournalFilter } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route((req: Request) => {
  const db = getDb();
  const trades = journalTradeRecords(db, parseJournalFilter(query(req)));
  return json(buildReport(trades, { timeZone: getSettings(db).timeZone }));
});
