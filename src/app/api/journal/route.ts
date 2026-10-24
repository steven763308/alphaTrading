import { getDb } from "@/lib/server/db/client";
import { json, query, route } from "@/lib/server/http";
import { journalFacets, listJournal } from "@/lib/server/repo/journal";
import { parseJournalFilter } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route((req: Request) => {
  const q = query(req);
  const limit = Math.min(Number(q.get("limit") || 100), 500);
  const offset = Math.max(Number(q.get("offset") || 0), 0);
  const db = getDb();
  return json({ ...listJournal(db, parseJournalFilter(q), { limit, offset }), facets: journalFacets(db) });
});
