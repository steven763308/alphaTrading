import { eq } from "drizzle-orm";
import { getDb } from "@/lib/server/db/client";
import { strategies } from "@/lib/server/db/schema";
import { body, json, route } from "@/lib/server/http";
import { strategySchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const s = await body(req, strategySchema.partial());
  const row = getDb().update(strategies).set(s).where(eq(strategies.id, Number((await ctx.params).id))).returning().get();
  return json(row);
});
