import { getDb } from "@/lib/server/db/client";
import { query, route } from "@/lib/server/http";
import { journalCsv } from "@/lib/server/repo/journal";
import { parseJournalFilter } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route((req: Request) => {
  const csv = journalCsv(getDb(), parseJournalFilter(query(req)));
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tradelab-journal-${stamp}.csv"`,
    },
  });
});
