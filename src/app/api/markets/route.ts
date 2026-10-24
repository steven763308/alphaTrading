import { ASSET_CLASSES, CATALOG } from "@/lib/market/catalog";
import { marketStatus } from "@/lib/market/calendars";
import { json, route } from "@/lib/server/http";
import { listProviders, resolveProvider } from "@/lib/server/services/market-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Market catalog with per-mode availability. A symbol shows as unavailable (with the
 * reason) when no configured provider can serve it — no substitute data is offered.
 */
export const GET = route(() => {
  const now = Date.now();
  const instruments = CATALOG.map((c) => {
    const hist = resolveProvider(c.symbol, "historical");
    const live = resolveProvider(c.symbol, "live");
    return {
      symbol: c.symbol,
      name: c.name,
      assetClass: c.assetClass,
      unit: c.unit,
      contractSize: c.contractSize,
      leverage: c.leverage,
      session: marketStatus(c.calendar, now),
      historical: { provider: hist.provider, reason: hist.reason, candidates: hist.candidates },
      live: { provider: live.provider, reason: live.reason, candidates: live.candidates },
    };
  });
  return json({ assetClasses: ASSET_CLASSES, instruments, providers: listProviders() });
});
