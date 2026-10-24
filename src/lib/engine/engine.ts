/**
 * Shared execution engine used by both historical replay and live paper trading.
 *
 * Execution assumptions (see docs/EXECUTION_MODEL.md for the full write-up):
 *  1. Candle prices are treated as mid prices. Buys trade at the ask and sells at the
 *     bid, each half the configured spread away from the candle price.
 *  2. Market orders fill immediately at the last known price (replay: the close of the
 *     cursor bar; live: the latest streamed price) plus spread and slippage.
 *  3. Pending orders only fill on bars whose open time is >= order.activeFrom, so a
 *     bar that was already in progress (or in the past) when the order was placed can
 *     never fill it. This is the primary look-ahead guard.
 *  4. Limit orders and take profits fill at their price (or the open if the bar gaps
 *     through it in the trader's favour), with maker fees and no slippage.
 *  5. Stop orders and stop losses fill at the trigger price (or the open if the bar
 *     gaps through it) with taker fees and adverse slippage.
 *  6. If SL and TP are both touched within one bar the engine assumes the SL was hit
 *     first (worst case) unless lower-timeframe bars are supplied to resolve the order.
 *  7. If an exit level is touched on the same bar a pending entry fills mid-bar, the
 *     SL is assumed hit and the TP is NOT assumed hit (worst case), unless resolved
 *     with lower-timeframe bars.
 *  8. Fill prices are rounded to the tick size against the trader.
 *  9. Money (fees, costs, risk, P&L, margin, financing) is in ACCOUNT currency:
 *     quote-currency amounts are converted at each fill's own rate (ctx.conversion).
 * 10. With a leveraged spec, orders need free margin at placement and again at fill;
 *     a margin stop-out is evaluated at each bar close.
 * 11. Financing accrues at each daily rollover (17:00 New York) inside a bar.
 */
import { rollovers } from "@/lib/market/calendars";
import {
  applySlippage,
  bidOf,
  candlePriceFor,
  costsForBar,
  directionOf,
  exitSide,
  feeFor,
  fxRate,
  grossPnl,
  marginFor,
  notional,
  round,
  roundFill,
  roundToStep,
  sidePrice,
  unrealizedPnl,
} from "./math";
import {
  EngineError,
  type Bar,
  type EngineContext,
  type EngineEvent,
  type EngineResult,
  type EngineState,
  type Execution,
  type ExecutionFlag,
  type ExitReason,
  type Liquidity,
  type Order,
  type OrderType,
  type Position,
  type Side,
} from "./types";

/** The latest known market price and the current simulation time. */
export interface MarketSnapshot {
  price: number;
  time: number;
}

export interface PlaceOrderInput {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  qty: number;
  price?: number | null;
  sl?: number | null;
  tp?: number | null;
}

export interface ProcessBarOptions {
  /** Lower-timeframe bars covering exactly this bar, used to resolve intrabar ordering. */
  subBars?: Bar[];
  /** Extra flags to attach to every execution produced (e.g. reconciled_gap). */
  flags?: ExecutionFlag[];
}

export interface ProcessBarResult extends EngineResult {
  /** True when the outcome depended on a worst-case intrabar assumption. */
  ambiguous: boolean;
}

class Run {
  state: EngineState;
  executions: Execution[] = [];
  events: EngineEvent[] = [];
  changedOrders = new Map<string, Order>();
  changedPositions = new Map<string, Position>();
  ambiguous = false;

  constructor(input: EngineState) {
    this.state = structuredClone(input);
  }

  touchOrder(o: Order) {
    this.changedOrders.set(o.id, o);
  }
  touchPosition(p: Position) {
    this.changedPositions.set(p.id, p);
  }

  result(): ProcessBarResult {
    for (const p of [...this.state.positions, ...this.changedPositions.values()]) {
      delete p.openedThisBar;
      delete p.entryAtOpen;
    }
    return {
      state: this.state,
      executions: this.executions,
      events: this.events,
      orders: [...this.changedOrders.values()].map((o) => structuredClone(o)),
      positions: [...this.changedPositions.values()].map((p) => structuredClone(p)),
      ambiguous: this.ambiguous,
    };
  }
}

const qtyOk = (qty: number, ctx: EngineContext) => Number.isFinite(qty) && qty >= ctx.spec.minQty;

/** Fee + fixed commission for one fill, in account currency. */
function fillFee(price: number, qty: number, liquidity: Liquidity, ctx: EngineContext): number {
  const { spec, costs } = ctx;
  const pct = feeFor(price, qty, spec, liquidity === "maker" ? costs.makerFeeBps : costs.takerFeeBps);
  return round(pct * fxRate(price, ctx.conversion) + (costs.commissionPerUnit ?? 0) * qty, 8);
}

/** Equity minus used margin, account-wide, with this symbol's positions marked at `price`. */
function freeMargin(state: EngineState, price: number, ctx: EngineContext): number {
  let used = ctx.margin?.otherUsedMargin ?? 0;
  let unrealized = ctx.margin?.otherUnrealized ?? 0;
  for (const p of state.positions) {
    if (p.symbol !== ctx.spec.symbol) continue;
    used += p.margin ?? 0;
    unrealized += unrealizedPnl(p.direction, p.entryPrice, price, p.qty, ctx.spec, ctx.costs, ctx.conversion);
  }
  return round(state.balance + unrealized - used, 8);
}

function marginError(state: EngineState, price: number, qty: number, ctx: EngineContext): string | null {
  if (!ctx.spec.leverage) return null;
  const required = marginFor(price, qty, ctx.spec, ctx.conversion) + fillFee(price, qty, "taker", ctx);
  const free = freeMargin(state, price, ctx);
  if (required <= free) return null;
  return `Insufficient margin: needs ${required.toFixed(2)}, free ${free.toFixed(2)} (leverage 1:${ctx.spec.leverage})`;
}

function tick(price: number, ctx: EngineContext): number {
  return roundToStep(price, ctx.spec.tickSize, "nearest");
}

function validateLevels(
  side: Side,
  entryRef: number,
  sl: number | null,
  tp: number | null,
): string | null {
  if (side === "buy") {
    if (sl != null && sl >= entryRef) return "Stop loss must be below the entry price for a long";
    if (tp != null && tp <= entryRef) return "Take profit must be above the entry price for a long";
  } else {
    if (sl != null && sl <= entryRef) return "Stop loss must be above the entry price for a short";
    if (tp != null && tp >= entryRef) return "Take profit must be below the entry price for a short";
  }
  if (sl != null && !(sl > 0)) return "Stop loss must be positive";
  if (tp != null && !(tp > 0)) return "Take profit must be positive";
  return null;
}

function validatePendingPrice(side: Side, type: OrderType, price: number, market: number, ctx: EngineContext): string | null {
  const quote = sidePrice(market, side, ctx.costs);
  if (type === "limit") {
    if (side === "buy" && price >= quote) return "Buy limit must be below the current ask (use Market or Stop)";
    if (side === "sell" && price <= quote) return "Sell limit must be above the current bid (use Market or Stop)";
  }
  if (type === "stop") {
    if (side === "buy" && price <= quote) return "Buy stop must be above the current ask (use Market or Limit)";
    if (side === "sell" && price >= quote) return "Sell stop must be below the current bid (use Market or Limit)";
  }
  return null;
}

function openPosition(
  run: Run,
  order: Order,
  fillPrice: number,
  referencePrice: number,
  preSlipPrice: number,
  time: number,
  liquidity: Liquidity,
  flags: ExecutionFlag[],
  ctx: EngineContext,
  openedThisBar: boolean,
  entryAtOpen: boolean,
): Position {
  const { spec, costs } = ctx;
  const direction = directionOf(order.side);
  const rate = fxRate(fillPrice, ctx.conversion);
  const fee = fillFee(fillPrice, order.qty, liquidity, ctx);
  const spreadCost = round(Math.abs(preSlipPrice - referencePrice) * order.qty * spec.contractSize * rate, 8);
  const slippageCost = round(Math.abs(fillPrice - preSlipPrice) * order.qty * spec.contractSize * rate, 8);
  const positionId = `pos_${order.id}`;

  const position: Position = {
    id: positionId,
    orderId: order.id,
    symbol: order.symbol,
    direction,
    qty: order.qty,
    entryPrice: fillPrice,
    entryTime: time,
    sl: order.sl,
    tp: order.tp,
    initialSl: order.sl,
    initialTp: order.tp,
    initialRisk: order.sl != null ? round(Math.abs(fillPrice - order.sl) * order.qty * spec.contractSize * rate, 8) : null,
    status: "open",
    exitPrice: null,
    exitTime: null,
    exitReason: null,
    entryFee: fee,
    exitFee: 0,
    slippageCost: round(spreadCost + slippageCost, 8),
    financing: 0,
    margin: marginFor(fillPrice, order.qty, spec, ctx.conversion),
    grossPnl: null,
    netPnl: null,
    openedThisBar,
  };
  if (entryAtOpen) position.entryAtOpen = true;

  const execution: Execution = {
    id: `${positionId}:entry`,
    orderId: order.id,
    positionId,
    symbol: order.symbol,
    kind: "entry",
    side: order.side,
    qty: order.qty,
    price: fillPrice,
    referencePrice: round(referencePrice, 10),
    fee,
    spreadCost,
    slippageCost,
    liquidity,
    reason: order.type,
    time,
    flags: [...new Set(flags)],
    fxRate: round(rate, 10),
  };

  order.status = "filled";
  order.filledAt = time;
  run.state.orders = run.state.orders.filter((o) => o.id !== order.id);
  run.state.positions.push(position);
  run.state.balance = round(run.state.balance - fee, 8);
  run.executions.push(execution);
  run.touchOrder(order);
  run.touchPosition(position);
  run.events.push({ type: "order_filled", time, orderId: order.id, executionId: execution.id });
  run.events.push({ type: "position_opened", time, position: structuredClone(position) });
  return position;
}

function closePositionAt(
  run: Run,
  position: Position,
  fillPrice: number,
  referencePrice: number,
  preSlipPrice: number,
  time: number,
  reason: ExitReason,
  liquidity: Liquidity,
  flags: ExecutionFlag[],
  ctx: EngineContext,
) {
  const { spec } = ctx;
  const side = exitSide(position.direction);
  // Realised P&L is converted at the exit (the usual broker convention).
  const rate = fxRate(fillPrice, ctx.conversion);
  const fee = fillFee(fillPrice, position.qty, liquidity, ctx);
  const spreadCost = round(Math.abs(preSlipPrice - referencePrice) * position.qty * spec.contractSize * rate, 8);
  const slippageCost = round(Math.abs(fillPrice - preSlipPrice) * position.qty * spec.contractSize * rate, 8);
  const gross = round(grossPnl(position.direction, position.entryPrice, fillPrice, position.qty, spec) * rate, 8);

  position.status = "closed";
  position.exitPrice = fillPrice;
  position.exitTime = time;
  position.exitReason = reason;
  position.exitFee = fee;
  position.slippageCost = round(position.slippageCost + spreadCost + slippageCost, 8);
  position.grossPnl = gross;
  position.netPnl = round(gross - position.entryFee - fee + (position.financing ?? 0), 8);
  delete position.entryAtOpen;

  const execution: Execution = {
    id: `${position.id}:exit`,
    orderId: position.orderId,
    positionId: position.id,
    symbol: position.symbol,
    kind: "exit",
    side,
    qty: position.qty,
    price: fillPrice,
    referencePrice: round(referencePrice, 10),
    fee,
    spreadCost,
    slippageCost,
    liquidity,
    reason,
    time,
    flags: [...new Set(flags)],
    fxRate: round(rate, 10),
  };

  run.state.positions = run.state.positions.filter((p) => p.id !== position.id);
  run.state.balance = round(run.state.balance + gross - fee, 8);
  run.executions.push(execution);
  run.touchPosition(position);
  run.events.push({ type: "position_closed", time, position: structuredClone(position), executionId: execution.id });
}

/** Taker fill at a quoted price: apply slippage and round against the trader. */
function takerFill(quote: number, side: Side, ctx: EngineContext) {
  const fill = roundFill(applySlippage(quote, side, ctx.costs), side, ctx.spec);
  return { fill, preSlip: quote };
}

function tryFillOrder(run: Run, order: Order, bar: Bar, ctx: EngineContext, flags: ExecutionFlag[]) {
  if (order.activeFrom > bar.time || order.price == null) return;
  const side = order.side;
  const q = (p: number) => sidePrice(p, side, ctx.costs);
  const qOpen = q(bar.open);
  const qHigh = q(bar.high);
  const qLow = q(bar.low);
  const P = order.price;

  let fill: number | null = null;
  let preSlip = 0;
  let atOpen = false;
  let liquidity: Liquidity = "maker";

  if (order.type === "limit") {
    if (side === "buy") {
      if (qOpen <= P) {
        fill = Math.min(roundFill(qOpen, side, ctx.spec), P);
        atOpen = true;
      } else if (qLow <= P) fill = P;
    } else {
      if (qOpen >= P) {
        fill = Math.max(roundFill(qOpen, side, ctx.spec), P);
        atOpen = true;
      } else if (qHigh >= P) fill = P;
    }
    preSlip = fill ?? 0;
  } else if (order.type === "stop") {
    liquidity = "taker";
    let trigger: number | null = null;
    if (side === "buy") {
      if (qOpen >= P) {
        trigger = qOpen;
        atOpen = true;
      } else if (qHigh >= P) trigger = P;
    } else {
      if (qOpen <= P) {
        trigger = qOpen;
        atOpen = true;
      } else if (qLow <= P) trigger = P;
    }
    if (trigger != null) {
      const t = takerFill(trigger, side, ctx);
      fill = t.fill;
      preSlip = t.preSlip;
    }
  }

  if (fill == null) return;
  const marginErr = marginError(run.state, fill, order.qty, ctx);
  if (marginErr) {
    // Not enough margin when the order would have filled: reject it rather than fill.
    order.status = "rejected";
    order.rejectReason = `${marginErr} at fill`;
    run.state.orders = run.state.orders.filter((o) => o.id !== order.id);
    run.touchOrder(order);
    run.events.push({ type: "order_rejected", time: bar.time, order: structuredClone(order), reason: order.rejectReason });
    return;
  }
  const reference = atOpen ? bar.open : candlePriceFor(preSlip, side, ctx.costs);
  openPosition(
    run,
    order,
    fill,
    reference,
    preSlip,
    bar.time,
    liquidity,
    atOpen ? [...flags, "gap_open"] : flags,
    ctx,
    true,
    atOpen,
  );
}

function evaluateExits(run: Run, position: Position, bar: Bar, ctx: EngineContext, flags: ExecutionFlag[]) {
  // A position cannot be stopped out by price action that happened before it existed.
  let enteredInside = position.openedThisBar === true && !position.entryAtOpen;
  if (position.entryTime > bar.time) {
    if (bar.end == null || position.entryTime > bar.end) return;
    // Opened somewhere inside this live segment: the path after entry is unknown.
    enteredInside = true;
  }
  const side = exitSide(position.direction);
  const isLong = position.direction === "long";
  const q = (p: number) => sidePrice(p, side, ctx.costs);
  const qOpen = q(bar.open);
  const qHigh = q(bar.high);
  const qLow = q(bar.low);
  const { sl, tp } = position;

  const slTouched = sl != null && (isLong ? qLow <= sl : qHigh >= sl);
  const tpTouched = tp != null && (isLong ? qHigh >= tp : qLow <= tp);

  const exitTime = Math.max(bar.time, position.entryTime);
  const exitSl = (quote: number, extra: ExecutionFlag[]) => {
    const t = takerFill(quote, side, ctx);
    const reference = candlePriceFor(t.preSlip, side, ctx.costs);
    closePositionAt(run, position, t.fill, reference, t.preSlip, exitTime, "stop_loss", "taker", [...flags, ...extra], ctx);
  };
  const exitTp = (price: number, extra: ExecutionFlag[]) => {
    const reference = candlePriceFor(price, side, ctx.costs);
    closePositionAt(run, position, price, reference, price, exitTime, "take_profit", "maker", [...flags, ...extra], ctx);
  };

  if (enteredInside) {
    // Entry happened somewhere inside this bar: we do not know the path after entry.
    if (sl != null && (isLong ? sl >= position.entryPrice : sl <= position.entryPrice)) {
      // The entry itself gapped beyond the stop: exit immediately at the entry-time quote.
      run.ambiguous = true;
      exitSl(isLong ? Math.min(sl, bidOf(bar.open, ctx.costs)) : Math.max(sl, q(bar.open)), ["gap_open"]);
      return;
    }
    if (slTouched) {
      run.ambiguous = true;
      exitSl(sl!, ["ambiguous_entry_bar"]);
      return;
    }
    if (tpTouched) run.ambiguous = true; // TP never assumed on the entry bar.
    return;
  }

  if (!position.openedThisBar) {
    if (sl != null && (isLong ? qOpen <= sl : qOpen >= sl)) {
      exitSl(qOpen, ["gap_open"]);
      return;
    }
    if (tp != null && (isLong ? qOpen >= tp : qOpen <= tp)) {
      exitTp(roundFill(qOpen, side, ctx.spec), ["gap_open"]);
      return;
    }
  }

  if (slTouched && tpTouched) {
    run.ambiguous = true;
    exitSl(sl!, ["ambiguous_sl_tp"]);
  } else if (slTouched) {
    exitSl(sl!, []);
  } else if (tpTouched) {
    exitTp(tp!, []);
  }
}

function runBar(run: Run, bar: Bar, ctx: EngineContext, flags: ExecutionFlag[]) {
  for (const p of run.state.positions) {
    delete p.openedThisBar;
    delete p.entryAtOpen;
  }
  // A bar with an observed bid/ask spread uses it instead of the configured spread.
  ctx = bar.spread != null ? { ...ctx, costs: costsForBar(ctx.costs, bar) } : ctx;
  const pending = [...run.state.orders]
    .filter((o) => o.status === "pending" && o.symbol === ctx.spec.symbol)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const order of pending) tryFillOrder(run, order, bar, ctx, flags);

  const positions = [...run.state.positions]
    .filter((p) => p.symbol === ctx.spec.symbol)
    .sort((a, b) => a.entryTime - b.entryTime || a.id.localeCompare(b.id));
  for (const position of positions) evaluateExits(run, position, bar, ctx, flags);
}

/**
 * Advance the simulation by one bar. Pending orders are filled first (in submission
 * order), then exits are evaluated for every open position.
 */
export function processBar(
  state: EngineState,
  bar: Bar,
  ctx: EngineContext,
  options: ProcessBarOptions = {},
): ProcessBarResult {
  const run = new Run(state);
  const flags = options.flags ?? [];
  if (options.subBars && options.subBars.length > 0) {
    const subs = [...options.subBars].sort((a, b) => a.time - b.time);
    for (const sub of subs) runBar(run, sub, ctx, [...flags, "resolved_lower_tf"]);
  } else {
    runBar(run, bar, ctx, flags);
  }
  applyFinancing(run, bar, ctx);
  applyStopOut(run, bar, ctx);
  return run.result();
}

/** End of the period a bar covers (live segments carry it; replay bars use barMs). */
function barEnd(bar: Bar, ctx: EngineContext): number | null {
  return bar.end ?? (ctx.barMs ? bar.time + ctx.barMs : null);
}

/**
 * Charge/credit financing at each daily rollover inside the bar for positions opened
 * before it. Bar-granular: a position closed earlier in the same bar is not charged.
 */
function applyFinancing(run: Run, bar: Bar, ctx: EngineContext) {
  const fin = ctx.spec.financing;
  const end = barEnd(bar, ctx);
  if (!fin || end == null || (!fin.longAnnualPct && !fin.shortAnnualPct)) return;
  for (const r of rollovers(bar.time, end, fin.tripleDay)) {
    for (const p of run.state.positions) {
      if (p.symbol !== ctx.spec.symbol || p.entryTime >= r.time) continue;
      const pct = p.direction === "long" ? fin.longAnnualPct : fin.shortAnnualPct;
      if (!pct) continue;
      const amount = round((notional(bar.close, p.qty, ctx.spec, ctx.conversion) * pct) / 100 / 365 * r.days, 8);
      p.financing = round((p.financing ?? 0) + amount, 8);
      run.state.balance = round(run.state.balance + amount, 8);
      run.touchPosition(p);
      run.events.push({ type: "position_financed", time: r.time, positionId: p.id, amount, days: r.days });
    }
  }
}

/**
 * Margin stop-out evaluated at the bar close: if equity / used margin falls below the
 * stop-out level, every open position on this symbol is closed at the close price.
 * The intrabar moment of the stop-out is unknown, so fills are flagged `stop_out`.
 */
function applyStopOut(run: Run, bar: Bar, ctx: EngineContext) {
  const level = ctx.margin?.stopOutLevelPct;
  if (!ctx.spec.leverage || !level) return;
  const mine = run.state.positions.filter((p) => p.symbol === ctx.spec.symbol);
  if (mine.length === 0) return;
  const c = bar.spread != null ? { ...ctx, costs: costsForBar(ctx.costs, bar) } : ctx;
  const used = mine.reduce((s, p) => s + (p.margin ?? 0), ctx.margin?.otherUsedMargin ?? 0);
  if (used <= 0) return;
  const equity = freeMargin(run.state, bar.close, c) + used; // free margin = equity − used
  if ((equity / used) * 100 >= level) return;
  const time = barEnd(bar, ctx) ?? bar.time;
  for (const p of mine) {
    const side = exitSide(p.direction);
    const t = takerFill(sidePrice(bar.close, side, c.costs), side, c);
    closePositionAt(run, p, t.fill, bar.close, t.preSlip, Math.max(time, p.entryTime), "stop_out", "taker", ["stop_out"], c);
  }
}

/**
 * True if processing this bar would require a worst-case intrabar assumption.
 * Callers can then fetch lower-timeframe bars and pass them as `subBars`.
 */
export function needsIntrabarResolution(state: EngineState, bar: Bar, ctx: EngineContext): boolean {
  return processBar(state, bar, ctx).ambiguous;
}

export function placeOrder(
  state: EngineState,
  input: PlaceOrderInput,
  market: MarketSnapshot,
  ctx: EngineContext,
): EngineResult & { order: Order } {
  const run = new Run(state);
  const qty = roundToStep(input.qty, ctx.spec.qtyStep, "down");
  const price = input.type === "market" || input.price == null ? null : tick(input.price, ctx);
  const sl = input.sl == null ? null : tick(input.sl, ctx);
  const tp = input.tp == null ? null : tick(input.tp, ctx);

  const order: Order = {
    id: input.id,
    clientOrderId: input.clientOrderId,
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    qty,
    price,
    sl,
    tp,
    status: "pending",
    createdAt: market.time,
    activeFrom: market.time,
    filledAt: null,
    cancelledAt: null,
    rejectReason: null,
  };

  const reject = (reason: string) => {
    order.status = "rejected";
    order.rejectReason = reason;
    run.touchOrder(order);
    run.events.push({ type: "order_rejected", time: market.time, order: structuredClone(order), reason });
    return { ...run.result(), order: structuredClone(order) };
  };

  if (input.symbol !== ctx.spec.symbol) return reject(`Symbol ${input.symbol} does not match instrument ${ctx.spec.symbol}`);
  if (!(market.price > 0)) return reject("No valid market price available");
  if (!qtyOk(qty, ctx)) return reject(`Quantity must be at least ${ctx.spec.minQty}`);
  if (input.type !== "market" && (price == null || !(price > 0))) return reject("Limit and stop orders need a positive price");

  const marketQuote = sidePrice(market.price, input.side, ctx.costs);
  if (price != null) {
    const err = validatePendingPrice(input.side, input.type, price, market.price, ctx);
    if (err) return reject(err);
  }
  const levelErr = validateLevels(input.side, price ?? marketQuote, sl, tp);
  if (levelErr) return reject(levelErr);
  if (input.type === "market" && ctx.marketOpen === false) return reject("Market is closed — use a limit or stop order, or wait for the session to open");
  const marginErr = marginError(run.state, price ?? marketQuote, qty, ctx);
  if (marginErr) return reject(marginErr);

  run.touchOrder(order);
  run.events.push({ type: "order_placed", time: market.time, order: structuredClone(order) });

  if (input.type === "market") {
    const t = takerFill(marketQuote, input.side, ctx);
    // Market fills cannot be beyond SL/TP after slippage — re-validate against the fill.
    const fillErr = validateLevels(input.side, t.fill, sl, tp);
    if (fillErr) {
      run.events.pop();
      return reject(`${fillErr} (after spread/slippage the fill would be ${t.fill})`);
    }
    run.state.orders.push(order);
    const pos = openPosition(run, order, t.fill, market.price, t.preSlip, market.time, "taker", [], ctx, false, false);
    delete pos.openedThisBar;
  } else {
    run.state.orders.push(order);
  }
  return { ...run.result(), order: structuredClone(order) };
}

export function cancelOrder(state: EngineState, orderId: string, time: number): EngineResult {
  const run = new Run(state);
  const order = run.state.orders.find((o) => o.id === orderId);
  if (!order) throw new EngineError(`Pending order ${orderId} not found`);
  order.status = "cancelled";
  order.cancelledAt = time;
  run.state.orders = run.state.orders.filter((o) => o.id !== orderId);
  run.touchOrder(order);
  run.events.push({ type: "order_cancelled", time, orderId });
  return run.result();
}

export function modifyOrder(
  state: EngineState,
  orderId: string,
  changes: { price?: number; sl?: number | null; tp?: number | null },
  market: MarketSnapshot,
  ctx: EngineContext,
): EngineResult {
  const run = new Run(state);
  const order = run.state.orders.find((o) => o.id === orderId);
  if (!order) throw new EngineError(`Pending order ${orderId} not found`);
  const price = changes.price !== undefined ? tick(changes.price, ctx) : order.price!;
  const sl = changes.sl !== undefined ? (changes.sl == null ? null : tick(changes.sl, ctx)) : order.sl;
  const tp = changes.tp !== undefined ? (changes.tp == null ? null : tick(changes.tp, ctx)) : order.tp;
  const err = validatePendingPrice(order.side, order.type, price, market.price, ctx) ?? validateLevels(order.side, price, sl, tp);
  if (err) throw new EngineError(err);
  order.price = price;
  order.sl = sl;
  order.tp = tp;
  // A moved order must not fill on price action from before the modification.
  order.activeFrom = Math.max(order.activeFrom, market.time);
  run.touchOrder(order);
  run.events.push({ type: "order_modified", time: market.time, orderId, changes: { price, sl, tp } });
  return run.result();
}

export function modifyPosition(
  state: EngineState,
  positionId: string,
  changes: { sl?: number | null; tp?: number | null },
  market: MarketSnapshot,
  ctx: EngineContext,
): EngineResult {
  const run = new Run(state);
  const position = run.state.positions.find((p) => p.id === positionId);
  if (!position) throw new EngineError(`Open position ${positionId} not found`);
  const sl = changes.sl !== undefined ? (changes.sl == null ? null : tick(changes.sl, ctx)) : position.sl;
  const tp = changes.tp !== undefined ? (changes.tp == null ? null : tick(changes.tp, ctx)) : position.tp;
  // Levels must be on the correct side of the current closing quote, otherwise they
  // would trigger instantly on stale price action.
  const closeQuote = sidePrice(market.price, exitSide(position.direction), ctx.costs);
  const err = validateLevels(position.direction === "long" ? "buy" : "sell", closeQuote, sl, tp);
  if (err) throw new EngineError(`${err} (current exit quote ${round(closeQuote, 8)})`);
  position.sl = sl;
  position.tp = tp;
  run.touchPosition(position);
  run.events.push({ type: "position_modified", time: market.time, positionId, changes: { sl, tp } });
  return run.result();
}

export function closePosition(
  state: EngineState,
  positionId: string,
  market: MarketSnapshot,
  ctx: EngineContext,
  reason: ExitReason = "manual",
  flags: ExecutionFlag[] = [],
): EngineResult {
  const run = new Run(state);
  const position = run.state.positions.find((p) => p.id === positionId);
  if (!position) throw new EngineError(`Open position ${positionId} not found`);
  if (!(market.price > 0)) throw new EngineError("No valid market price available");
  if (ctx.marketOpen === false) throw new EngineError("Market is closed — the position can be closed when the session reopens");
  const side = exitSide(position.direction);
  const t = takerFill(sidePrice(market.price, side, ctx.costs), side, ctx);
  closePositionAt(run, position, t.fill, market.price, t.preSlip, market.time, reason, "taker", flags, ctx);
  return run.result();
}

export function unrealizedTotal(state: EngineState, prices: Record<string, number>, ctx: EngineContext | ((symbol: string) => EngineContext)): number {
  let total = 0;
  for (const p of state.positions) {
    const price = prices[p.symbol];
    if (!(price > 0)) continue;
    const c = typeof ctx === "function" ? ctx(p.symbol) : ctx;
    total += unrealizedPnl(p.direction, p.entryPrice, price, p.qty, c.spec, c.costs, c.conversion);
  }
  return round(total, 8);
}

/** Margin currently reserved by open positions (account currency). */
export function usedMargin(state: EngineState, symbol?: string): number {
  return round(state.positions.filter((p) => !symbol || p.symbol === symbol).reduce((s, p) => s + (p.margin ?? 0), 0), 8);
}

export function emptyState(balance: number): EngineState {
  return { balance, orders: [], positions: [] };
}
