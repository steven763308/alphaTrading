/**
 * Core domain types for the ByteX TradeLab simulation engine.
 *
 * The engine is pure and deterministic: given the same starting state, the same
 * bars and the same commands, it always produces the same orders, executions
 * and positions. It never reads the clock, randomness or I/O.
 *
 * All timestamps are UTC epoch milliseconds.
 */

export type Side = "buy" | "sell";
export type Direction = "long" | "short";
export type OrderType = "market" | "limit" | "stop";
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected";
export type PositionStatus = "open" | "closed";
export type ExitReason = "stop_loss" | "take_profit" | "manual" | "session_end" | "stop_out";
export type Liquidity = "maker" | "taker";

/**
 * Flags attached to executions so that any simulation uncertainty is explicit.
 * - gap_open: the bar opened beyond the trigger, filled at the open price.
 * - ambiguous_sl_tp: SL and TP were both touched in one bar; worst case (SL) assumed.
 * - ambiguous_entry_bar: an exit level was touched in the same bar as the entry;
 *   SL assumed hit, TP never assumed hit.
 * - resolved_lower_tf: the bar was resolved using lower-timeframe candles.
 * - reconciled_gap: filled while replaying data that arrived after a feed outage.
 * - stale_data: price data was older than the staleness threshold.
 * - stop_out: closed by the margin stop-out at the bar close (intrabar path unknown).
 */
export type ExecutionFlag =
  | "gap_open"
  | "ambiguous_sl_tp"
  | "ambiguous_entry_bar"
  | "resolved_lower_tf"
  | "reconciled_gap"
  | "stale_data"
  | "stop_out";

export interface Bar {
  /** Bar open time (UTC ms). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * Optional end time for partial bars (live stream segments). A position opened
   * inside (time, end] is evaluated with the conservative entry-bar rules.
   */
  end?: number;
  /**
   * Observed full bid/ask spread in price units (e.g. from bid+ask candles). When
   * present it replaces the configured spread for this bar.
   */
  spread?: number;
}

export interface InstrumentSpec {
  symbol: string;
  /** Minimum price increment. */
  tickSize: number;
  /** Minimum quantity increment. */
  qtyStep: number;
  minQty: number;
  /** Units of the underlying per 1 quantity (1 coin, 100,000 for an FX lot, 100 oz for XAU). */
  contractSize: number;
  /** Maximum leverage. 1 = fully funded. Omitted = no margin checks (legacy behaviour). */
  leverage?: number;
  /** Annual financing rates (%) applied at each daily rollover; negative = cost. */
  financing?: { longAnnualPct: number; shortAnnualPct: number; tripleDay: number | null };
}

/** Percentage costs in basis points (1 bp = 0.01%); commission in account currency. */
export interface CostModel {
  makerFeeBps: number;
  takerFeeBps: number;
  /** Full bid/ask spread around the candle price (used when a bar has no observed spread). */
  spreadBps: number;
  /** Applied adversely to taker fills (market, stop, stop-loss). */
  slippageBps: number;
  /** Fixed commission per 1 quantity unit per side, in account currency (e.g. USD per lot). */
  commissionPerUnit?: number;
}

/**
 * How a quote-currency amount becomes account currency:
 * - identity: quote currency is the account currency (EURUSD, XAUUSD, BTCUSDT for USD).
 * - inverse: base currency is the account currency, so divide by the instrument's own
 *   price at that moment (USDJPY: JPY P&L / price = USD).
 * - rate: multiply by an external quote→account rate (EURGBP needs GBPUSD).
 */
export type Conversion = { kind: "identity" } | { kind: "inverse" } | { kind: "rate"; rate: number };

export interface EngineContext {
  spec: InstrumentSpec;
  costs: CostModel;
  /** Defaults to identity. */
  conversion?: Conversion;
  /** Bar length, used for rollover windows (live segments use bar.end instead). */
  barMs?: number;
  /** False when the market is closed: market orders and manual closes are refused. */
  marketOpen?: boolean;
  /** Account-wide margin context for exposure outside this engine state. */
  margin?: { otherUsedMargin: number; otherUnrealized: number; stopOutLevelPct: number };
}

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  /** Limit price or stop trigger price. Null for market orders. */
  price: number | null;
  sl: number | null;
  tp: number | null;
  status: OrderStatus;
  /** Simulation time the order was submitted. */
  createdAt: number;
  /** The order may only fill on bars whose open time is >= activeFrom (look-ahead guard). */
  activeFrom: number;
  filledAt: number | null;
  cancelledAt: number | null;
  rejectReason: string | null;
}

export interface Position {
  id: string;
  orderId: string;
  symbol: string;
  direction: Direction;
  qty: number;
  entryPrice: number;
  entryTime: number;
  sl: number | null;
  tp: number | null;
  initialSl: number | null;
  initialTp: number | null;
  /** |entry - initial SL| * qty * contractSize, converted to account currency at entry. Null without SL. */
  initialRisk: number | null;
  status: PositionStatus;
  exitPrice: number | null;
  exitTime: number | null;
  exitReason: ExitReason | null;
  entryFee: number;
  exitFee: number;
  /** Cost of slippage + spread across both fills, in account currency. */
  slippageCost: number;
  /** Accumulated financing/swap (account currency; negative = paid). */
  financing?: number;
  /** Margin reserved at entry (account currency). */
  margin?: number;
  grossPnl: number | null;
  netPnl: number | null;
  /** Position was opened during the bar currently being processed. */
  openedThisBar?: boolean;
  /** Transient: the position was opened at the open of the current bar (gap fill). */
  entryAtOpen?: boolean;
}

export interface Execution {
  /** Idempotency key: `${positionId}:entry` or `${positionId}:exit`. */
  id: string;
  orderId: string;
  positionId: string;
  symbol: string;
  kind: "entry" | "exit";
  side: Side;
  qty: number;
  price: number;
  /** Candle (mid) price the fill was derived from, before spread and slippage. */
  referencePrice: number;
  /** Fee + commission, account currency. */
  fee: number;
  /** Account currency. */
  spreadCost: number;
  /** Account currency. */
  slippageCost: number;
  liquidity: Liquidity;
  reason: OrderType | ExitReason;
  time: number;
  flags: ExecutionFlag[];
  /** Quote→account conversion rate applied to this fill (1 when identity). */
  fxRate?: number;
}

export type EngineEvent =
  | { type: "order_placed"; time: number; order: Order }
  | { type: "order_rejected"; time: number; order: Order; reason: string }
  | { type: "order_cancelled"; time: number; orderId: string }
  | { type: "order_modified"; time: number; orderId: string; changes: Partial<Pick<Order, "price" | "sl" | "tp">> }
  | { type: "order_filled"; time: number; orderId: string; executionId: string }
  | { type: "position_opened"; time: number; position: Position }
  | { type: "position_modified"; time: number; positionId: string; changes: { sl?: number | null; tp?: number | null } }
  | { type: "position_closed"; time: number; position: Position; executionId: string }
  | { type: "position_financed"; time: number; positionId: string; amount: number; days: number };

export interface EngineState {
  /** Realized cash balance (fees already deducted). */
  balance: number;
  /** Pending orders only. */
  orders: Order[];
  /** Open positions only. */
  positions: Position[];
}

export interface EngineResult {
  state: EngineState;
  executions: Execution[];
  events: EngineEvent[];
  /** Orders whose status changed (filled/cancelled/rejected/modified/new). */
  orders: Order[];
  /** Positions that were opened, modified or closed. */
  positions: Position[];
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}
