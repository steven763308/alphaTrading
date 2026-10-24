import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { getLiveState, liveCommand } from "@/lib/server/services/live";
import { liveCommandSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (req: Request) => {
  const cmd = await body(req, liveCommandSchema);
  const db = getDb();
  const result = await liveCommand(db, cmd);
  return json({ ...result, state: getLiveState(db) });
});
