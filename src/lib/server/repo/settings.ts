import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { settings } from "../db/schema";
import { DEFAULT_SETTINGS, type AppSettings } from "../settings-defaults";

const KEY = "app";

export function getSettings(db: Db): AppSettings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const stored = (row?.value ?? {}) as Partial<AppSettings>;
  const costs = { ...DEFAULT_SETTINGS.costs, ...(stored.costs ?? {}) };
  const byClass = { ...DEFAULT_SETTINGS.costsByAssetClass };
  for (const [k, v] of Object.entries(stored.costsByAssetClass ?? {})) byClass[k] = { ...byClass[k], ...v };
  // The legacy single `costs` setting remains the crypto default.
  if (stored.costs && !stored.costsByAssetClass?.crypto) byClass.crypto = costs;
  return { ...DEFAULT_SETTINGS, ...stored, costs: byClass.crypto ?? costs, costsByAssetClass: byClass };
}

export function saveSettings(db: Db, value: AppSettings): AppSettings {
  db.insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
  return value;
}
