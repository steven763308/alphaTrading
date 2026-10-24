import { json, route } from "@/lib/server/http";
import { getProvider } from "@/lib/server/services/market-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

/** Connectivity / credential check for one provider. */
export const POST = route(async (_req: Request, ctx: Ctx) => {
  const p = getProvider((await ctx.params).id);
  return json({ id: p.id, ...(await p.checkStatus()) });
});
