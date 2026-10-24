import { getDb } from "@/lib/server/db/client";
import { json, route } from "@/lib/server/http";
import { verifyReplay } from "@/lib/server/services/backtest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export const POST = route(async (_req: Request, ctx: Ctx) => json(await verifyReplay(getDb(), (await ctx.params).id)));
