"use client";

import { useState } from "react";
import { unrealizedPnl } from "@/lib/engine/math";
import type { CostModel, InstrumentSpec } from "@/lib/engine/types";
import { FLAG_LABELS, UNCERTAIN_FLAGS, fmtMoney, fmtPrice, fmtQty, fmtR, fmtTime, pnlClass } from "@/lib/client/format";
import type { OrderRow, PositionRow } from "@/lib/client/types";

interface Props {
  openPositions: PositionRow[];
  pendingOrders: OrderRow[];
  closedPositions: PositionRow[];
  recentOrders: OrderRow[];
  prices: Record<string, number>;
  spec: InstrumentSpec;
  costs: CostModel;
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
    ["log", "Order log"],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-line px-2">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`border-b-2 px-2 py-1.5 ${tab === k ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}>
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

function Positions({ openPositions, prices, spec, costs, timeZone, busy, onClose }: Props) {
  if (!openPositions.length) return <Empty text="No open positions" />;
  return (
    <table className="data-table">
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
          <th>Opened</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {openPositions.map((pos) => {
          const mark = prices[pos.symbol];
          const dir = pos.direction as "long" | "short";
          const u = mark ? unrealizedPnl(dir, pos.entryPrice, mark, pos.qty, spec, costs) : null;
          const r = u != null && pos.initialRisk ? u / pos.initialRisk : null;
          return (
            <tr key={pos.id}>
              <td>{pos.symbol}</td>
              <td className={dir === "long" ? "text-up" : "text-down"}>{dir}</td>
              <td className="r num">{fmtQty(pos.qty, spec.qtyStep)}</td>
              <td className="r num">{fmtPrice(pos.entryPrice, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(pos.sl, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(pos.tp, spec.tickSize)}</td>
              <td className="r num">{fmtPrice(mark, spec.tickSize)}</td>
              <td className={`r num ${pnlClass(u)}`}>{fmtMoney(u, { sign: true })}</td>
              <td className={`r num ${pnlClass(r)}`}>{fmtR(r)}</td>
              <td className="num text-muted">{fmtTime(pos.entryTime, timeZone)}</td>
              <td className="r">
                <button className="btn py-0.5 text-[12px]" disabled={busy} onClick={() => onClose(pos.id)}>
                  Close
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Orders({ pendingOrders, spec, timeZone, busy, onCancel }: Props) {
  if (!pendingOrders.length) return <Empty text="No pending orders" />;
  return (
    <table className="data-table">
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
  );
}

export function FlagBadges({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  const uncertain = flags.some((f) => UNCERTAIN_FLAGS.has(f));
  return (
    <span
      title={flags.map((f) => FLAG_LABELS[f] ?? f).join("\n")}
      className={`ml-1 rounded px-1 text-[10px] ${uncertain ? "bg-warn/15 text-warn" : "bg-accent/15 text-accent"}`}
    >
      {uncertain ? "approx" : "1m"}
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
          <th className="r">Fees</th>
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
              <td className="r num text-muted">{fmtMoney(pos.entryFee + pos.exitFee)}</td>
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
