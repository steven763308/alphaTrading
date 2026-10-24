import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { createSession, listSessions } from "@/lib/server/services/backtest";
import { createSessionSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(() => json(listSessions(getDb())));

export const POST = route(async (req: Request) => {
  const input = await body(req, createSessionSchema);
  return json(await createSession(getDb(), input), { status: 201 });
});
