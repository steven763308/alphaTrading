"use client";

import { useState } from "react";
import { unrealizedPnl } from "@/lib/engine/math";
import type { Conversion, CostModel, InstrumentSpec } from "@/lib/engine/types";
import { FLAG_LABELS, UNCERTAIN_FLAGS, fmtMoney, fmtPrice, fmtQty, fmtR, fmtTime, pnlClass } from "@/lib/client/format";
import type { OrderRow, PositionRow } from "@/lib/client/types";

interface Props {
  openPositions: PositionRow[];
  pendingOrders: OrderRow[];
  closedPositions: PositionRow[];
  recentOrders: OrderRow[];
  /** Latest prices keyed by instrument id. */
  prices: Record<string, number>;
  /** The charted instrument; positions on it get live client-side P&L. */
  instrumentId: string;
  spec: InstrumentSpec;
  costs: CostModel;
  conversion?: Conversion;
  /** Server-computed unrealized for positions on other instruments (live). */
  serverUnrealized?: Record<string, number>;
  timeZone: string;
  busy: boolean;
  onClose: (positionId: string) => void;
  onCancel: (orderId: string) => void;
  flagsByPosition?: Record<string, string[]>;
}

type Tab = "positions" | "orders" | "history" | "log";

export function TradesPanel(p: Props) {
  const [tab, setTab] = useState<Tab>("positions");
  const tabs: [Tab, string][] = [
    ["positions", `Positions (${p.openPositions.length})`],
    ["orders", `Orders (${p.pendingOrders.length})`],
    ["history", `History (${p.closedPositions.length})`],
    ["log", "Log"],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`shrink-0 border-b-2 px-2 py-2 ${tab === k ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "positions" && <Positions {...p} />}
        {tab === "orders" && <Orders {...p} />}
        {tab === "history" && <History {...p} />}
        {tab === "log" && <OrderLog {...p} />}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-center text-muted">{text}</p>;
}

function positionPnl(pos: PositionRow, p: Props): number | null {
  if (pos.instrumentId === p.instrumentId) {
    const mark = p.prices[pos.instrumentId];
    if (!mark) return null;
    return unrealizedPnl(pos.direction as "long" | "short", pos.entryPrice, mark, pos.qty, p.spec, p.costs, p.conversion);
  }
  return p.serverUnrealized?.[pos.id] ?? null;
}

function Positions(p: Props) {
  const { openPositions, prices, spec, timeZone, busy, onClose } = p;
  if (!openPositions.length) return <Empty text="No open positions" />;
  const rows = openPositions.map((pos) => {
    const u = positionPnl(pos, p);
    return { pos, u, r: u != null && pos.initialRisk ? u / pos.initialRisk : null, mark: prices[pos.instrumentId] };
  });
  return (
    <>
      {/* Phones: cards with a big Close button */}
      <div className="divide-y divide-line md:hidden">
        {rows.map(({ pos, u, r, mark }) => (
          <div key={pos.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{pos.symbol}</span>
                <span className={pos.direction === "long" ? "text-up" : "text-down"}>{pos.direction}</span>
                <span className="num text-muted">{fmtQty(pos.qty, spec.qtyStep)}</span>
              </div>
              <div className="num text-[12px] text-muted">
                {fmtPrice(pos.entryPrice, spec.tickSize)} → {fmtPrice(mark, spec.tickSize)} · SL {fmtPrice(pos.sl, spec.tickSize)} · TP {fmtPrice(pos.tp, spec.tickSize)}
              </div>
            </div>
            <div className="text-right">
              <div className={`num ${pnlClass(u)}`}>{fmtMoney(u, { sign: true })}</div>
              <div className={`num text-[12px] ${pnlClass(r)}`}>{fmtR(r)}</div>
            </div>
            <button className="btn" disabled={busy} onClick={() => onClose(pos.id)}>
              Close
            </button>
          </div>
        ))}
      </div>
      <table className="data-table hidden md:table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Side</th>
            <th className="r">Qty</th>
            <th className="r">Entry</th>
            <th className="r">SL</th>
            <th className="r">TP</th>
            <th className="r">Mark</th>
            <th className="r">Unrealized</th>
            <th className="r">R</th>
            <th className="r">Swap</th>
            <th className="r">Margin</th>
            <th>Opened</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ pos, u, r, mark }) => (
            <tr key={pos.id}>
              <td>{pos.symbol}</td>
              <td className={pos.direction === "long" ? "text-up" : "text-down"}>{pos.direction}</td>
              <td className="r num">{fmtQty(pos.qty, spec.qtyStep)}</td>
              <td className="r num">{fmtPrice(pos.entryPrice, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(pos.sl, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(pos.tp, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(mark, spec.tickSize)}</td>
              <td className={`r num ${pnlClass(u)}`}>{fmtMoney(u, { sign: true })}</td>
              <td className={`r num ${pnlClass(r)}`}>{fmtR(r)}</td>
              <td className={`r num ${pnlClass(pos.financing)}`}>{pos.financing ? fmtMoney(pos.financing, { sign: true }) : "—"}</td>
              <td className="r num text-muted">{pos.margin ? fmtMoney(pos.margin) : "—"}</td>
              <td className="num text-muted">{fmtTime(pos.entryTime, timeZone)}</td>
              <td className="r">
                <button className="btn py-0.5 text-[12px]" disabled={busy} onClick={() => onClose(pos.id)}>
                  Close
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Orders({ pendingOrders, spec, timeZone, busy, onCancel }: Props) {
  if (!pendingOrders.length) return <Empty text="No pending orders" />;
  return (
    <>
      <div className="divide-y divide-line md:hidden">
        {pendingOrders.map((o) => (
          <div key={o.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{o.symbol}</span>
                <span className={o.side === "buy" ? "text-up" : "text-down"}>
                  {o.side} {o.type}
                </span>
                <span className="num text-muted">{fmtQty(o.qty, spec.qtyStep)}</span>
              </div>
              <div className="num text-[12px] text-muted">
                @ {fmtPrice(o.price, spec.tickSize)} · SL {fmtPrice(o.sl, spec.tickSize)} · TP {fmtPrice(o.tp, spec.tickSize)}
              </div>
            </div>
            <button className="btn" disabled={busy} onClick={() => onCancel(o.id)}>
              Cancel
            </button>
          </div>
        ))}
      </div>
      <table className="data-table hidden md:table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Type</th>
            <th>Side</th>
            <th className="r">Qty</th>
            <th className="r">Price</th>
            <th className="r">SL</th>
            <th className="r">TP</th>
            <th>Placed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {pendingOrders.map((o) => (
            <tr key={o.id}>
              <td>{o.symbol}</td>
              <td className="capitalize">{o.type}</td>
              <td className={o.side === "buy" ? "text-up" : "text-down"}>{o.side}</td>
              <td className="r num">{fmtQty(o.qty, spec.qtyStep)}</td>
              <td className="r num">{fmtPrice(o.price, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(o.sl, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(o.tp, spec.tickSize)}</td>
              <td className="num text-muted">{fmtTime(o.createdAt, timeZone)}</td>
              <td className="r">
                <button className="btn py-0.5 text-[12px]" disabled={busy} onClick={() => onCancel(o.id)}>
                  Cancel
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function FlagBadges({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  const uncertain = flags.some((f) => UNCERTAIN_FLAGS.has(f));
  const label = uncertain ? "approx" : flags.includes("resolved_lower_tf") ? "1m" : "info";
  return (
    <span title={flags.map((f) => FLAG_LABELS[f] ?? f).join("\n")} className={`ml-1 rounded px-1 text-[10px] ${uncertain ? "bg-warn/15 text-warn" : "bg-accent/15 text-accent"}`}>
      {label}
    </span>
  );
}

function History({ closedPositions, spec, timeZone, flagsByPosition }: Props) {
  if (!closedPositions.length) return <Empty text="No closed trades yet" />;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Closed</th>
          <th>Symbol</th>
          <th>Side</th>
          <th className="r">Qty</th>
          <th className="r">Entry</th>
          <th className="r">Exit</th>
          <th>Reason</th>
          <th className="r">Costs</th>
          <th className="r">Net P&L</th>
          <th className="r">R</th>
        </tr>
      </thead>
      <tbody>
        {closedPositions.map((pos) => {
          const r = pos.netPnl != null && pos.initialRisk ? pos.netPnl / pos.initialRisk : null;
          return (
            <tr key={pos.id}>
              <td className="num text-muted">{fmtTime(pos.exitTime, timeZone)}</td>
              <td>{pos.symbol}</td>
              <td className={pos.direction === "long" ? "text-up" : "text-down"}>{pos.direction}</td>
              <td className="r num">{fmtQty(pos.qty, spec.qtyStep)}</td>
              <td className="r num">{fmtPrice(pos.entryPrice, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(pos.exitPrice, spec.tickSize)}</td>
              <td>
                {pos.exitReason?.replace("_", " ")}
                <FlagBadges flags={flagsByPosition?.[pos.id] ?? []} />
              </td>
              <td className="r num text-muted" title={pos.financing ? `incl. financing ${fmtMoney(pos.financing, { sign: true })}` : undefined}>
                {fmtMoney(pos.entryFee + pos.exitFee - (pos.financing ?? 0))}
              </td>
              <td className={`r num ${pnlClass(pos.netPnl)}`}>{fmtMoney(pos.netPnl, { sign: true })}</td>
              <td className={`r num ${pnlClass(r)}`}>{fmtR(r)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OrderLog({ recentOrders, spec, timeZone }: Props) {
  if (!recentOrders.length) return <Empty text="No orders yet" />;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Placed</th>
          <th>Symbol</th>
          <th>Type</th>
          <th>Side</th>
          <th className="r">Qty</th>
          <th className="r">Price</th>
          <th>Status</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {recentOrders.map((o) => (
          <tr key={o.id}>
            <td className="num text-muted">{fmtTime(o.createdAt, timeZone)}</td>
            <td>{o.symbol}</td>
            <td className="capitalize">{o.type}</td>
            <td className={o.side === "buy" ? "text-up" : "text-down"}>{o.side}</td>
            <td className="r num">{fmtQty(o.qty, spec.qtyStep)}</td>
            <td className="r num">{fmtPrice(o.price, spec.tickSize)}</td>
            <td className={o.status === "rejected" ? "text-down" : "text-muted"}>{o.status}</td>
            <td className="max-w-[320px] truncate text-muted" title={o.rejectReason ?? o.entryNote ?? ""}>
              {o.rejectReason ?? o.entryNote ?? ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
