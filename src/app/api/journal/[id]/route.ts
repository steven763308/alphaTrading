import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { getJournalEntry, updateJournalAnnotations } from "@/lib/server/repo/journal";
import { NotFoundError } from "@/lib/server/services/backtest";
import { journalPatchSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, ctx: Ctx) => {
  const entry = getJournalEntry(getDb(), Number((await ctx.params).id));
  if (!entry) throw new NotFoundError("Journal entry not found");
  return json(entry);
});

/** Only personal annotations are editable; execution facts are immutable. */
export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const patch = await body(req, journalPatchSchema);
  const row = updateJournalAnnotations(getDb(), Number((await ctx.params).id), patch);
  if (!row) throw new NotFoundError("Journal entry not found");
  return json(row);
});
