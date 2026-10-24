import { getDb } from "@/lib/server/db/client";
import { json, route } from "@/lib/server/http";
import { getLiveState } from "@/lib/server/services/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(() => json(getLiveState(getDb())));
