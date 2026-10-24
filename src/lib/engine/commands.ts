/**
 * User commands as plain data, so they can be logged and replayed deterministically.
 */
import { cancelOrder, closePosition, modifyOrder, modifyPosition, placeOrder, type MarketSnapshot } from "./engine";
import type { EngineContext, EngineResult, EngineState, OrderType, Side } from "./types";

export type Command =
  | {
      kind: "place";
      orderId: string;
      clientOrderId: string;
      side: Side;
      type: OrderType;
      qty: number;
      price?: number | null;
      sl?: number | null;
      tp?: number | null;
    }
  | { kind: "cancel"; orderId: string }
  | { kind: "modify_order"; orderId: string; price?: number; sl?: number | null; tp?: number | null }
  | { kind: "modify_position"; positionId: string; sl?: number | null; tp?: number | null }
  | { kind: "close"; positionId: string };

export function applyCommand(state: EngineState, cmd: Command, market: MarketSnapshot, ctx: EngineContext): EngineResult {
  switch (cmd.kind) {
    case "place":
      return placeOrder(
        state,
        {
          id: cmd.orderId,
          clientOrderId: cmd.clientOrderId,
          symbol: ctx.spec.symbol,
          side: cmd.side,
          type: cmd.type,
          qty: cmd.qty,
          price: cmd.price ?? null,
          sl: cmd.sl ?? null,
          tp: cmd.tp ?? null,
        },
        market,
        ctx,
      );
    case "cancel":
      return cancelOrder(state, cmd.orderId, market.time);
    case "modify_order":
      return modifyOrder(state, cmd.orderId, { price: cmd.price, sl: cmd.sl, tp: cmd.tp }, market, ctx);
    case "modify_position":
      return modifyPosition(state, cmd.positionId, { sl: cmd.sl, tp: cmd.tp }, market, ctx);
    case "close":
      return closePosition(state, cmd.positionId, market, ctx, "manual");
  }
}

/** Merge sequential engine results into one (later versions of an entity win). */
export function mergeResults(results: EngineResult[], finalState: EngineState): EngineResult {
  const orders = new Map<string, EngineResult["orders"][number]>();
  const positions = new Map<string, EngineResult["positions"][number]>();
  const executions: EngineResult["executions"] = [];
  const events: EngineResult["events"] = [];
  for (const r of results) {
    for (const o of r.orders) orders.set(o.id, o);
    for (const p of r.positions) positions.set(p.id, p);
    executions.push(...r.executions);
    events.push(...r.events);
  }
  return { state: finalState, orders: [...orders.values()], positions: [...positions.values()], executions, events };
}
