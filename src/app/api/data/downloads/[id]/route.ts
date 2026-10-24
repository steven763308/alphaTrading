import { json, route } from "@/lib/server/http";
import { NotFoundError } from "@/lib/server/services/backtest";
import { getDownloadJob } from "@/lib/server/services/market-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export const GET = route(async (_req: Request, ctx: Ctx) => {
  const job = getDownloadJob((await ctx.params).id);
  if (!job) throw new NotFoundError("Download job not found (server restarted?)");
  return json(job);
});
