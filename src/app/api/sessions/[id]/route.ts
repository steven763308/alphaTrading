import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { deleteSession, getSessionView, updateSessionSettings } from "@/lib/server/services/backtest";
import { sessionPatchSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, ctx: Ctx) => json(getSessionView(getDb(), (await ctx.params).id)));

export const PATCH = route(async (req: Request, ctx: Ctx) => {
  const changes = await body(req, sessionPatchSchema);
  return json(updateSessionSettings(getDb(), (await ctx.params).id, changes));
});

export const DELETE = route(async (_req: Request, ctx: Ctx) => {
  deleteSession(getDb(), (await ctx.params).id);
  return json({ ok: true });
});
