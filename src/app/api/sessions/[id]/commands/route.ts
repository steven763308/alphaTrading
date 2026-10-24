import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { sessionCommand } from "@/lib/server/services/backtest";
import { commandSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (req: Request, ctx: Ctx) => {
  const cmd = await body(req, commandSchema);
  return json(sessionCommand(getDb(), (await ctx.params).id, cmd));
});
