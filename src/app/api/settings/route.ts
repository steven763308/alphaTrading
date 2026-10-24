import { getDb } from "@/lib/server/db/client";
import { body, json, route } from "@/lib/server/http";
import { getSettings, saveSettings } from "@/lib/server/repo/settings";
import { settingsSchema } from "@/lib/server/validation";
import { BINANCE_REST_URL, BINANCE_WS_URL } from "@/lib/market/binance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = route(() => json({ settings: getSettings(getDb()), endpoints: { rest: BINANCE_REST_URL, ws: BINANCE_WS_URL } }));

export const PUT = route(async (req: Request) => {
  const s = await body(req, settingsSchema);
  return json({ settings: saveSettings(getDb(), s) });
});
