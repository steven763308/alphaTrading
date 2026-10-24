/**
 * Instrument catalog: contract specifications and provider symbol mappings for the
 * markets TradeLab knows out of the box. Providers declare which entries they serve;
 * CSV imports can add anything else.
 *
 * Quantity units: crypto = coins, forex = lots (100,000 base units), metals = lots
 * (XAU 100 oz, XAG 5,000 oz), stocks/ETFs = shares.
 *
 * Leverage and financing values are TYPICAL RETAIL ASSUMPTIONS for simulation, not
 * any broker's actual terms — they are editable per session.
 */

export type AssetClass = "crypto" | "forex" | "metals" | "stocks" | "indices" | "futures" | "commodities" | "custom";

export const ASSET_CLASSES: { id: AssetClass; label: string }[] = [
  { id: "crypto", label: "Crypto" },
  { id: "forex", label: "Forex" },
  { id: "metals", label: "Metals" },
  { id: "stocks", label: "US Stocks / ETFs" },
  { id: "indices", label: "Indices" },
  { id: "futures", label: "Futures" },
  { id: "commodities", label: "Commodities" },
  { id: "custom", label: "Custom (CSV)" },
];

export type CalendarId = "24x7" | "fx" | "metals" | "us_equity";

export interface CatalogInstrument {
  symbol: string;
  assetClass: AssetClass;
  name: string;
  base: string;
  quote: string;
  tickSize: number;
  qtyStep: number;
  minQty: number;
  /** Units of the underlying per 1 quantity. */
  contractSize: number;
  unit: "coin" | "lot" | "share" | "contract";
  /** Max leverage assumed (1 = fully cash-funded). */
  leverage: number;
  calendar: CalendarId;
  /** Annual financing rate (%) applied at the daily rollover; negative = cost. */
  financing: { longAnnualPct: number; shortAnnualPct: number; tripleDay: number | null };
  /** Exchange/market time zone used for sessions. */
  timeZone: string;
  providers: Partial<Record<ProviderId, string>>;
  /** Dukascopy integer price scale. */
  dukascopyScale?: number;
}

export type ProviderId = "binance" | "dukascopy" | "oanda" | "alpaca" | "csv";

const NO_FIN = { longAnnualPct: 0, shortAnnualPct: 0, tripleDay: null };
// Typical retail CFD-style carry assumption: both sides pay a small markup. Wednesday triple.
const FX_FIN = { longAnnualPct: -2.5, shortAnnualPct: -2.5, tripleDay: 3 };
const METAL_FIN = { longAnnualPct: -6, shortAnnualPct: -1, tripleDay: 3 };

function crypto(symbol: string, base: string, tick: number, step: number, name: string): CatalogInstrument {
  return {
    symbol,
    assetClass: "crypto",
    name,
    base,
    quote: "USDT",
    tickSize: tick,
    qtyStep: step,
    minQty: step,
    contractSize: 1,
    unit: "coin",
    leverage: 1,
    calendar: "24x7",
    financing: NO_FIN,
    timeZone: "UTC",
    providers: { binance: symbol },
  };
}

function fx(base: string, quote: string, name: string): CatalogInstrument {
  const jpy = quote === "JPY";
  return {
    symbol: `${base}${quote}`,
    assetClass: "forex",
    name,
    base,
    quote,
    tickSize: jpy ? 0.001 : 0.00001,
    qtyStep: 0.01,
    minQty: 0.01,
    contractSize: 100_000,
    unit: "lot",
    leverage: 30,
    calendar: "fx",
    financing: FX_FIN,
    timeZone: "America/New_York",
    providers: { dukascopy: `${base}${quote}`, oanda: `${base}_${quote}` },
    dukascopyScale: jpy ? 1_000 : 100_000,
  };
}

function stock(symbol: string, name: string, etf = false): CatalogInstrument {
  return {
    symbol,
    assetClass: "stocks",
    name: etf ? `${name} (ETF)` : name,
    base: symbol,
    quote: "USD",
    tickSize: 0.01,
    qtyStep: 1,
    minQty: 1,
    contractSize: 1,
    unit: "share",
    leverage: 1,
    calendar: "us_equity",
    financing: NO_FIN,
    timeZone: "America/New_York",
    providers: { alpaca: symbol },
  };
}

export const CATALOG: CatalogInstrument[] = [
  crypto("BTCUSDT", "BTC", 0.01, 0.00001, "Bitcoin"),
  crypto("ETHUSDT", "ETH", 0.01, 0.0001, "Ether"),
  crypto("SOLUSDT", "SOL", 0.01, 0.001, "Solana"),
  crypto("BNBUSDT", "BNB", 0.01, 0.001, "BNB"),
  crypto("XRPUSDT", "XRP", 0.0001, 0.1, "XRP"),
  fx("EUR", "USD", "Euro / US Dollar"),
  fx("GBP", "USD", "British Pound / US Dollar"),
  fx("USD", "JPY", "US Dollar / Japanese Yen"),
  fx("AUD", "USD", "Australian Dollar / US Dollar"),
  fx("USD", "CAD", "US Dollar / Canadian Dollar"),
  fx("USD", "CHF", "US Dollar / Swiss Franc"),
  fx("NZD", "USD", "New Zealand Dollar / US Dollar"),
  fx("EUR", "GBP", "Euro / British Pound"),
  fx("EUR", "JPY", "Euro / Japanese Yen"),
  fx("GBP", "JPY", "British Pound / Japanese Yen"),
  {
    symbol: "XAUUSD",
    assetClass: "metals",
    name: "Gold / US Dollar",
    base: "XAU",
    quote: "USD",
    tickSize: 0.01,
    qtyStep: 0.01,
    minQty: 0.01,
    contractSize: 100,
    unit: "lot",
    leverage: 20,
    calendar: "metals",
    financing: METAL_FIN,
    timeZone: "America/New_York",
    providers: { dukascopy: "XAUUSD", oanda: "XAU_USD" },
    dukascopyScale: 1_000,
  },
  {
    symbol: "XAGUSD",
    assetClass: "metals",
    name: "Silver / US Dollar",
    base: "XAG",
    quote: "USD",
    tickSize: 0.001,
    qtyStep: 0.01,
    minQty: 0.01,
    contractSize: 5_000,
    unit: "lot",
    leverage: 10,
    calendar: "metals",
    financing: METAL_FIN,
    timeZone: "America/New_York",
    providers: { dukascopy: "XAGUSD", oanda: "XAG_USD" },
    dukascopyScale: 1_000,
  },
  stock("AAPL", "Apple"),
  stock("NVDA", "NVIDIA"),
  stock("TSLA", "Tesla"),
  stock("MSFT", "Microsoft"),
  stock("AMZN", "Amazon"),
  stock("SPY", "SPDR S&P 500", true),
  stock("QQQ", "Invesco QQQ", true),
];

export function findCatalog(symbol: string): CatalogInstrument | undefined {
  const s = symbol.toUpperCase();
  return CATALOG.find((c) => c.symbol === s);
}

export const ACCOUNT_CURRENCIES = ["USD", "USDT"] as const;

/** USD-pegged stablecoins are treated as USD 1:1 (documented assumption). */
export function normalizeCurrency(c: string): string {
  return c === "USDT" || c === "USDC" || c === "BUSD" || c === "FDUSD" ? "USD" : c.toUpperCase();
}
