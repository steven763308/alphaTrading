import { asc } from "drizzle-orm";
import { getDb } from "@/lib/server/db/client";
import { strategies } from "@/lib/server/db/schema";
import { body, json, route } from "@/lib/server/http";
import { strategySchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(() => json(getDb().select().from(strategies).orderBy(asc(strategies.name)).all()));

export const POST = route(async (req: Request) => {
  const s = await body(req, strategySchema);
  const row = getDb().insert(strategies).values(s).returning().get();
  return json(row, { status: 201 });
});
