/**
 * Normalized SQLite schema. All timestamps are UTC epoch milliseconds (integers).
 * Prices and quantities are stored as REAL; the engine rounds to tick/qty steps.
 *
 * Audit model:
 *  - orders, executions, positions are separate entities.
 *  - executions use a deterministic primary key (`${positionId}:entry|exit`), which is
 *    the idempotency control: the same fill can never be recorded twice.
 *  - simulation_events is append-only and records every command and engine event.
 *  - trade_journal derives from closed positions; only its annotation columns are editable.
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

export const marketDataSources = sqliteTable("market_data_sources", {
  id: text("id").primaryKey(), // 'binance' | 'csv'
  name: text("name").notNull(),
  kind: text("kind").notNull(), // 'exchange' | 'file'
  baseUrl: text("base_url"),
  createdAt: integer("created_at").notNull().default(now),
});

export const instruments = sqliteTable(
  "instruments",
  {
    id: text("id").primaryKey(), // e.g. 'binance:BTCUSDT'
    sourceId: text("source_id").notNull().references(() => marketDataSources.id),
    symbol: text("symbol").notNull(),
    market: text("market").notNull(), // 'crypto' | 'fx' | 'equity' | ...
    baseAsset: text("base_asset"),
    quoteAsset: text("quote_asset"),
    tickSize: real("tick_size").notNull(),
    qtyStep: real("qty_step").notNull(),
    minQty: real("min_qty").notNull(),
    contractSize: real("contract_size").notNull().default(1),
    /** Display name, e.g. "Gold / US Dollar". */
    displayName: text("display_name"),
    /** Quantity unit: coin | lot | share | contract. */
    unit: text("unit").notNull().default("coin"),
    /** Max leverage assumed for simulation (1 = fully funded). */
    leverage: real("leverage").notNull().default(1),
    /** Trading calendar id: 24x7 | fx | metals | us_equity. */
    calendar: text("calendar").notNull().default("24x7"),
    /** Market time zone (sessions/display), e.g. America/New_York. */
    timeZone: text("time_zone").notNull().default("UTC"),
    /** Financing assumption {longAnnualPct, shortAnnualPct, tripleDay}. */
    financing: text("financing", { mode: "json" }).$type<{ longAnnualPct: number; shortAnnualPct: number; tripleDay: number | null }>(),
    /** The provider's own symbol (e.g. XAU_USD on OANDA). */
    providerSymbol: text("provider_symbol"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("instruments_source_symbol").on(t.sourceId, t.symbol)],
);

export const marketDataDatasets = sqliteTable(
  "market_data_datasets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: text("source_id").notNull().references(() => marketDataSources.id),
    instrumentId: text("instrument_id").notNull().references(() => instruments.id),
    timeframe: text("timeframe").notNull(),
    /** 'live-cache' for append-only exchange data, or an import label for CSVs. */
    label: text("label").notNull(),
    /** Incremented whenever candles are appended. Closed candles are never rewritten. */
    version: integer("version").notNull().default(1),
    firstTime: integer("first_time"),
    lastTime: integer("last_time"),
    candleCount: integer("candle_count").notNull().default(0),
    /** What the OHLC prices represent: trade | mid | bid | ask. */
    priceBasis: text("price_basis").notNull().default("trade"),
    /** Provider metadata: feed name, licensing note, source time zone, etc. */
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("datasets_unique").on(t.sourceId, t.instrumentId, t.timeframe, t.label)],
);

export const candles = sqliteTable(
  "candles",
  {
    datasetId: integer("dataset_id")
      .notNull()
      .references(() => marketDataDatasets.id, { onDelete: "cascade" }),
    time: integer("time").notNull(),
    open: real("open").notNull(),
    high: real("high").notNull(),
    low: real("low").notNull(),
    close: real("close").notNull(),
    /** Observed bid/ask spread (price units) when the source provides both sides. */
    spread: real("spread"),
    volume: real("volume").notNull(),
  },
  (t) => [primaryKey({ columns: [t.datasetId, t.time] })],
);

/**
 * Time ranges already fetched from a provider for a dataset (bar open times,
 * inclusive). Lets incremental downloads skip known gaps such as FX weekends
 * instead of re-requesting them.
 */
export const datasetCoverage = sqliteTable(
  "dataset_coverage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    datasetId: integer("dataset_id")
      .notNull()
      .references(() => marketDataDatasets.id, { onDelete: "cascade" }),
    fromTime: integer("from_time").notNull(),
    toTime: integer("to_time").notNull(),
    fetchedAt: integer("fetched_at").notNull().default(now),
  },
  (t) => [index("coverage_dataset").on(t.datasetId, t.fromTime)],
);

export const strategies = sqliteTable("strategies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  color: text("color"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().default(now),
});

export const paperAccounts = sqliteTable("paper_accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // 'backtest' | 'live'
  currency: text("currency").notNull().default("USDT"),
  startingBalance: real("starting_balance").notNull(),
  balance: real("balance").notNull(),
  /** JSON CostModel snapshot used for every fill in this account. */
  costs: text("costs", { mode: "json" }).notNull(),
  riskPercent: real("risk_percent").notNull().default(1),
  /** Margin level (%) at which all leveraged positions are closed. */
  stopOutLevel: real("stop_out_level").notNull().default(50),
  /** Monotonic sequence for simulation_events of this account. */
  eventSeq: integer("event_seq").notNull().default(0),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const backtestSessions = sqliteTable(
  "backtest_sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    instrumentId: text("instrument_id").notNull().references(() => instruments.id),
    datasetId: integer("dataset_id").notNull().references(() => marketDataDatasets.id),
    timeframe: text("timeframe").notNull(),
    startTime: integer("start_time").notNull(),
    endTime: integer("end_time").notNull(),
    /** Cursor at session creation; replay verification starts here. */
    initialCursorTime: integer("initial_cursor_time").notNull(),
    /** Open time of the last revealed bar. Bars after this are never sent to the client. */
    cursorTime: integer("cursor_time").notNull(),
    /** Incremented on every state change; clients send it back to make requests idempotent. */
    revision: integer("revision").notNull().default(0),
    dataVersion: integer("data_version").notNull(),
    dataChecksum: text("data_checksum").notNull(),
    gapCount: integer("gap_count").notNull().default(0),
    strategyId: integer("strategy_id").references(() => strategies.id),
    resolveLowerTf: integer("resolve_lower_tf", { mode: "boolean" }).notNull().default(true),
    /** Leverage used for this session (fixed at creation, for deterministic replay). */
    leverage: real("leverage"),
    /** Cross-currency conversion series: dataset of e.g. GBPUSD, and whether to invert it. */
    conversionDatasetId: integer("conversion_dataset_id").references(() => marketDataDatasets.id),
    conversionInvert: integer("conversion_invert", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("active"), // 'active' | 'completed'
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("sessions_updated").on(t.updatedAt)],
);

export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => backtestSessions.id, { onDelete: "cascade" }),
    clientOrderId: text("client_order_id").notNull(),
    instrumentId: text("instrument_id").notNull().references(() => instruments.id),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    type: text("type").notNull(),
    qty: real("qty").notNull(),
    price: real("price"),
    sl: real("sl"),
    tp: real("tp"),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    activeFrom: integer("active_from").notNull(),
    filledAt: integer("filled_at"),
    cancelledAt: integer("cancelled_at"),
    rejectReason: text("reject_reason"),
    strategyId: integer("strategy_id").references(() => strategies.id),
    timeframe: text("timeframe").notNull(),
    mode: text("mode").notNull(), // 'historical' | 'live'
    entryNote: text("entry_note"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("orders_client_id").on(t.accountId, t.clientOrderId),
    index("orders_account_status").on(t.accountId, t.status),
  ],
);

export const positions = sqliteTable(
  "positions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => backtestSessions.id, { onDelete: "cascade" }),
    orderId: text("order_id")
      .notNull()
      .unique()
      .references(() => orders.id),
    instrumentId: text("instrument_id").notNull().references(() => instruments.id),
    symbol: text("symbol").notNull(),
    direction: text("direction").notNull(),
    qty: real("qty").notNull(),
    entryPrice: real("entry_price").notNull(),
    entryTime: integer("entry_time").notNull(),
    sl: real("sl"),
    tp: real("tp"),
    initialSl: real("initial_sl"),
    initialTp: real("initial_tp"),
    initialRisk: real("initial_risk"),
    status: text("status").notNull(),
    exitPrice: real("exit_price"),
    exitTime: integer("exit_time"),
    exitReason: text("exit_reason"),
    entryFee: real("entry_fee").notNull(),
    exitFee: real("exit_fee").notNull().default(0),
    slippageCost: real("slippage_cost").notNull().default(0),
    /** Accumulated financing/swap, account currency (negative = paid). */
    financing: real("financing").notNull().default(0),
    /** Margin reserved at entry, account currency. */
    margin: real("margin").notNull().default(0),
    grossPnl: real("gross_pnl"),
    netPnl: real("net_pnl"),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("positions_account_status").on(t.accountId, t.status)],
);

export const executions = sqliteTable(
  "executions",
  {
    /** Deterministic idempotency key: `${positionId}:entry` | `${positionId}:exit`. */
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    side: text("side").notNull(),
    qty: real("qty").notNull(),
    price: real("price").notNull(),
    referencePrice: real("reference_price").notNull(),
    fee: real("fee").notNull(),
    spreadCost: real("spread_cost").notNull(),
    slippageCost: real("slippage_cost").notNull(),
    liquidity: text("liquidity").notNull(),
    reason: text("reason").notNull(),
    time: integer("time").notNull(),
    flags: text("flags", { mode: "json" }).$type<string[]>().notNull(),
    /** Quote→account conversion rate applied to this fill. */
    fxRate: real("fx_rate").notNull().default(1),
    recordedAt: integer("recorded_at").notNull().default(now),
  },
  (t) => [index("executions_account_time").on(t.accountId, t.time)],
);

export const tradeJournal = sqliteTable(
  "trade_journal",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    positionId: text("position_id")
      .notNull()
      .unique()
      .references(() => positions.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    mode: text("mode").notNull(),
    symbol: text("symbol").notNull(),
    market: text("market").notNull(),
    strategyId: integer("strategy_id"),
    strategyName: text("strategy_name"),
    timeframe: text("timeframe").notNull(),
    direction: text("direction").notNull(),
    entryTime: integer("entry_time").notNull(),
    exitTime: integer("exit_time").notNull(),
    entryPrice: real("entry_price").notNull(),
    exitPrice: real("exit_price").notNull(),
    qty: real("qty").notNull(),
    initialSl: real("initial_sl"),
    initialTp: real("initial_tp"),
    finalSl: real("final_sl"),
    finalTp: real("final_tp"),
    grossPnl: real("gross_pnl").notNull(),
    netPnl: real("net_pnl").notNull(),
    fees: real("fees").notNull(),
    slippageCost: real("slippage_cost").notNull(),
    financing: real("financing").notNull().default(0),
    /** Currency of all money columns in this row. */
    accountCurrency: text("account_currency").notNull().default("USDT"),
    /** Instrument quote currency (P&L was converted from this). */
    quoteCurrency: text("quote_currency"),
    initialRisk: real("initial_risk"),
    rMultiple: real("r_multiple"),
    holdingMs: integer("holding_ms").notNull(),
    entryReason: text("entry_reason").notNull(),
    exitReason: text("exit_reason").notNull(),
    dataSource: text("data_source").notNull(),
    dataVersion: text("data_version").notNull(),
    /** Union of uncertainty flags from both executions. */
    flags: text("flags", { mode: "json" }).$type<string[]>().notNull(),
    // ---- Editable annotations (never touch execution data) ----
    notes: text("notes"),
    setupQuality: integer("setup_quality"),
    ruleFollowed: integer("rule_followed", { mode: "boolean" }),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    annotations: text("annotations", { mode: "json" }).$type<{ time: number; price: number; text: string }[]>(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("journal_exit_time").on(t.exitTime),
    index("journal_filters").on(t.mode, t.symbol, t.strategyId, t.timeframe),
  ],
);

export const accountEquitySnapshots = sqliteTable(
  "account_equity_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    time: integer("time").notNull(),
    balance: real("balance").notNull(),
    equity: real("equity").notNull(),
    unrealized: real("unrealized").notNull(),
    usedMargin: real("used_margin").notNull().default(0),
    openPositions: integer("open_positions").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [uniqueIndex("snapshots_account_time_reason").on(t.accountId, t.time, t.reason)],
);

export const simulationEvents = sqliteTable(
  "simulation_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id")
      .notNull()
      .references(() => paperAccounts.id, { onDelete: "cascade" }),
    sessionId: text("session_id"),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    simTime: integer("sim_time").notNull(),
    wallTime: integer("wall_time").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (t) => [uniqueIndex("events_account_seq").on(t.accountId, t.seq), index("events_session").on(t.sessionId, t.seq)],
);

/** Live feed processing cursor per symbol, used to reconcile gaps after outages. */
export const liveSymbolCursors = sqliteTable("live_symbol_cursors", {
  symbol: text("symbol").primaryKey(),
  processedUntil: integer("processed_until").notNull(),
  lastPrice: real("last_price"),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});
