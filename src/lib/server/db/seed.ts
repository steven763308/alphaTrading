import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { DEFAULT_SETTINGS } from "../settings-defaults";

export const LIVE_ACCOUNT_ID = "live-default";

/** Idempotent seed: safe to run on every startup. */
export function seed(db: BetterSQLite3Database<typeof schema>) {
  db.insert(schema.marketDataSources)
    .values([
      { id: "binance", name: "Binance Spot (public)", kind: "exchange", baseUrl: "https://data-api.binance.vision" },
      { id: "dukascopy", name: "Dukascopy (historical)", kind: "datafeed", baseUrl: "https://datafeed.dukascopy.com/datafeed" },
      { id: "oanda", name: "OANDA v20", kind: "broker-data", baseUrl: "https://api-fxpractice.oanda.com" },
      { id: "alpaca", name: "Alpaca Market Data", kind: "broker-data", baseUrl: "https://data.alpaca.markets" },
      { id: "csv", name: "CSV import", kind: "file", baseUrl: null },
    ])
    .onConflictDoNothing()
    .run();

  db.insert(schema.paperAccounts)
    .values({
      id: LIVE_ACCOUNT_ID,
      name: "Live Paper",
      kind: "live",
      currency: "USDT",
      startingBalance: 10_000,
      balance: 10_000,
      costs: DEFAULT_SETTINGS.costs,
      riskPercent: DEFAULT_SETTINGS.riskPercent,
    })
    .onConflictDoNothing()
    .run();

  const count = db.select({ n: sql<number>`count(*)` }).from(schema.strategies).get()?.n ?? 0;
  if (count === 0) {
    db.insert(schema.strategies)
      .values([
        { name: "Breakout", color: "#3b82f6" },
        { name: "Pullback", color: "#22c55e" },
        { name: "Range reversal", color: "#f59e0b" },
      ])
      .run();
  }
}
