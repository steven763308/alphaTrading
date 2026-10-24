import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { advanceSession } from "@/lib/server/services/backtest";
import { advanceSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: Request, ctx: Ctx) => {
  const input = await body(req, advanceSchema);
  return json(await advanceSession(getDb(), (await ctx.params).id, input));
});
