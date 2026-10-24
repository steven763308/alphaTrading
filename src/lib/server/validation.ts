import { z } from "zod";
import { TIMEFRAMES } from "@/lib/market/timeframes";
import type { JournalFilter } from "./repo/journal";

const price = z.number().positive().finite();
const optLevel = price.nullable().optional();
const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,20}$/, "Invalid symbol");

export const costsSchema = z.object({
  makerFeeBps: z.number().min(0).max(1000),
  takerFeeBps: z.number().min(0).max(1000),
  spreadBps: z.number().min(0).max(1000),
  slippageBps: z.number().min(0).max(1000),
  commissionPerUnit: z.number().min(0).max(10_000).optional(),
});

export const timeframeSchema = z.enum(TIMEFRAMES);

export const createSessionSchema = z
  .object({
    name: z.string().max(100).optional(),
    source: z.enum(["auto", "binance", "dukascopy", "oanda", "alpaca", "csv"]),
    symbol: symbol.optional(),
    datasetId: z.number().int().positive().optional(),
    timeframe: timeframeSchema,
    from: z.number().int(),
    to: z.number().int(),
    startingBalance: z.number().positive().max(1e12),
    riskPercent: z.number().positive().max(100).optional(),
    strategyId: z.number().int().positive().nullable().optional(),
    costs: costsSchema.optional(),
    resolveLowerTf: z.boolean().optional(),
    leverage: z.number().min(1).max(500).optional(),
  })
  .refine((v) => v.to > v.from, { message: "End must be after start", path: ["to"] });

const placeSchema = z.object({
  kind: z.literal("place"),
  clientOrderId: z.string().min(1).max(100),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit", "stop"]),
  qty: z.number().positive().finite(),
  price: optLevel,
  sl: optLevel,
  tp: optLevel,
  strategyId: z.number().int().positive().nullable().optional(),
  entryNote: z.string().max(500).nullable().optional(),
});

export const commandSchema = z.discriminatedUnion("kind", [
  placeSchema,
  z.object({ kind: z.literal("cancel"), orderId: z.string().min(1) }),
  z.object({ kind: z.literal("modify_order"), orderId: z.string().min(1), price: price.optional(), sl: optLevel, tp: optLevel }),
  z.object({ kind: z.literal("modify_position"), positionId: z.string().min(1), sl: optLevel, tp: optLevel }),
  z.object({ kind: z.literal("close"), positionId: z.string().min(1) }),
]);

export const liveCommandSchema = z.intersection(commandSchema, z.object({ symbol, timeframe: timeframeSchema }));

export const advanceSchema = z.object({
  steps: z.number().int().min(1).max(500),
  revision: z.number().int().min(0),
});

export const sessionPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  strategyId: z.number().int().positive().nullable().optional(),
});

export const journalPatchSchema = z.object({
  notes: z.string().max(5000).nullable().optional(),
  setupQuality: z.number().int().min(1).max(5).nullable().optional(),
  ruleFollowed: z.boolean().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).nullable().optional(),
  annotations: z
    .array(z.object({ time: z.number().int(), price: z.number(), text: z.string().max(200) }))
    .max(50)
    .nullable()
    .optional(),
});

export const settingsSchema = z.object({
  timeZone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone"),
  riskPercent: z.number().positive().max(100),
  costs: costsSchema,
  costsByAssetClass: z.record(z.string(), costsSchema).default({}),
  staleAfterSeconds: z.number().int().min(5).max(600),
  reconcileLookbackHours: z.number().int().min(1).max(24 * 30),
  defaultSymbol: symbol,
  defaultTimeframe: timeframeSchema,
});

export const strategySchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  archived: z.boolean().optional(),
});

export const csvImportSchema = z.object({
  symbol: z.string().trim().min(2).max(30),
  timeframe: timeframeSchema,
  text: z.string().min(10).max(60_000_000),
  label: z.string().max(80).optional(),
  market: z.string().max(30).optional(),
  tickSize: z.number().positive().optional(),
  qtyStep: z.number().positive().optional(),
  minQty: z.number().positive().optional(),
  contractSize: z.number().positive().optional(),
});

export function parseJournalFilter(q: URLSearchParams): JournalFilter {
  const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
  const strategy = q.get("strategyId");
  const mode = q.get("mode");
  const direction = q.get("direction");
  return {
    symbol: q.get("symbol") || undefined,
    market: q.get("market") || undefined,
    strategyId: strategy === "none" ? "none" : strategy ? Number(strategy) : undefined,
    timeframe: q.get("timeframe") || undefined,
    mode: mode === "historical" || mode === "live" ? mode : undefined,
    direction: direction === "long" || direction === "short" ? direction : undefined,
    sessionId: q.get("sessionId") || undefined,
    from: num("from"),
    to: num("to"),
  };
}
