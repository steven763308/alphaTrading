"use client";

import { useMemo } from "react";
import { feeFor, roundToStep, sidePrice } from "@/lib/engine/math";
import { riskPositionSize } from "@/lib/engine/sizing";
import type { CostModel, InstrumentSpec } from "@/lib/engine/types";
import { fmtMoney, fmtPrice, fmtQty } from "@/lib/client/format";
import type { Strategy, TicketDraft } from "@/lib/client/types";

interface Props {
  draft: TicketDraft;
  onChange: (d: TicketDraft) => void;
  spec: InstrumentSpec;
  costs: CostModel;
  price: number | null;
  equity: number;
  strategies: Strategy[];
  disabledReason: string | null;
  submitting: boolean;
  onSubmit: (order: { side: "buy" | "sell"; type: TicketDraft["type"]; qty: number; price: number | null; sl: number | null; tp: number | null }) => void;
}

function NumField({ label, value, onChange, step, placeholder, disabled }: { label: string; value: number | null; onChange: (v: number | null) => void; step: number; placeholder?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="input num"
        type="number"
        step={step}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </label>
  );
}

export function computeTicket(draft: TicketDraft, spec: InstrumentSpec, costs: CostModel, price: number | null, equity: number) {
  const entryRef = draft.type === "market" ? (price != null ? sidePrice(price, draft.side, costs) : null) : draft.entry;
  let qty = draft.qty ?? 0;
  let sizingError: string | null = null;
  if (draft.sizing === "risk") {
    if (entryRef == null || draft.sl == null) {
      qty = 0;
      sizingError = "Set a stop loss to size by risk";
    } else {
      const r = riskPositionSize({ equity, riskPercent: draft.riskPercent, entry: entryRef, stop: draft.sl, side: draft.side, spec, costs });
      qty = r.qty;
      sizingError = r.error;
    }
  } else {
    qty = roundToStep(qty, spec.qtyStep, "down");
  }
  const risk = entryRef != null && draft.sl != null && qty > 0 ? Math.abs(entryRef - draft.sl) * qty * spec.contractSize : null;
  const reward = entryRef != null && draft.tp != null && qty > 0 ? Math.abs(draft.tp - entryRef) * qty * spec.contractSize : null;
  const rr = risk && reward ? reward / risk : null;
  const notional = entryRef != null ? entryRef * qty * spec.contractSize : null;
  const fees = entryRef != null && qty > 0 ? feeFor(entryRef, qty, spec, draft.type === "limit" ? costs.makerFeeBps : costs.takerFeeBps) * 2 : null;

  let levelError: string | null = null;
  if (entryRef != null) {
    const long = draft.side === "buy";
    if (draft.sl != null && (long ? draft.sl >= entryRef : draft.sl <= entryRef)) levelError = `Stop loss must be ${long ? "below" : "above"} entry`;
    else if (draft.tp != null && (long ? draft.tp <= entryRef : draft.tp >= entryRef)) levelError = `Take profit must be ${long ? "above" : "below"} entry`;
  }
  if (draft.type !== "market" && draft.entry == null) levelError = "Set an entry price";
  return { entryRef, qty, sizingError, risk, reward, rr, notional, fees, levelError };
}

export function OrderTicket({ draft, onChange, spec, costs, price, equity, strategies, disabledReason, submitting, onSubmit }: Props) {
  const set = (patch: Partial<TicketDraft>) => onChange({ ...draft, ...patch });
  const t = useMemo(() => computeTicket(draft, spec, costs, price, equity), [draft, spec, costs, price, equity]);
  const long = draft.side === "buy";
  const canSubmit = !disabledReason && !submitting && t.qty > 0 && !t.levelError && !(draft.sizing === "risk" && t.sizingError);

  const quick = (kind: "sl" | "tp") => {
    const ref = t.entryRef ?? price;
    if (ref == null) return;
    if (kind === "sl") set({ sl: roundToStep(ref * (long ? 0.99 : 1.01), spec.tickSize) });
    else {
      const sl = draft.sl ?? roundToStep(ref * (long ? 0.99 : 1.01), spec.tickSize);
      const dist = Math.abs(ref - sl);
      set({ sl, tp: roundToStep(long ? ref + 2 * dist : ref - 2 * dist, spec.tickSize) });
    }
  };

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-bg p-0.5">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => set({ side: s })}
            className={`rounded py-1.5 font-medium ${draft.side === s ? (s === "buy" ? "bg-up text-[#04110f]" : "bg-down text-[#1a0505]") : "text-muted hover:text-ink"}`}
          >
            {s === "buy" ? "Long" : "Short"}
          </button>
        ))}
      </div>

      <div className="flex gap-1">
        {(["market", "limit", "stop"] as const).map((ty) => (
          <button
            key={ty}
            onClick={() => set({ type: ty, entry: ty === "market" ? null : (draft.entry ?? price) })}
            className={`flex-1 rounded border py-1 capitalize ${draft.type === ty ? "border-accent text-ink" : "border-line text-muted hover:text-ink"}`}
          >
            {ty}
          </button>
        ))}
      </div>

      {draft.type === "market" ? (
        <div className="flex items-baseline justify-between rounded-md border border-line px-2 py-1.5">
          <span className="text-muted">Est. fill ({long ? "ask" : "bid"})</span>
          <span className="num">{fmtPrice(t.entryRef, spec.tickSize)}</span>
        </div>
      ) : (
        <NumField label={`${draft.type === "limit" ? "Limit" : "Stop"} price`} value={draft.entry} step={spec.tickSize} onChange={(v) => set({ entry: v })} />
      )}

      <div className="grid grid-cols-2 gap-2">
        <div>
          <NumField label="Stop loss" value={draft.sl} step={spec.tickSize} onChange={(v) => set({ sl: v })} placeholder="optional" />
          <button className="mt-1 text-[11px] text-muted hover:text-ink" onClick={() => quick("sl")}>
            1% away
          </button>
        </div>
        <div>
          <NumField label="Take profit" value={draft.tp} step={spec.tickSize} onChange={(v) => set({ tp: v })} placeholder="optional" />
          <button className="mt-1 text-[11px] text-muted hover:text-ink" onClick={() => quick("tp")}>
            2R target
          </button>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="label mb-0">Size</span>
          <div className="flex gap-2 text-[11px]">
            {(["risk", "qty"] as const).map((m) => (
              <button key={m} onClick={() => set({ sizing: m, qty: m === "qty" ? t.qty || draft.qty : draft.qty })} className={draft.sizing === m ? "text-ink" : "text-muted hover:text-ink"}>
                {m === "risk" ? "By risk %" : "Fixed qty"}
              </button>
            ))}
          </div>
        </div>
        {draft.sizing === "risk" ? (
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Risk % of equity" value={draft.riskPercent} step={0.1} onChange={(v) => set({ riskPercent: v ?? 0 })} />
            <div>
              <span className="label">Quantity</span>
              <div className="num rounded-md border border-line px-2 py-[5px]">{t.qty > 0 ? fmtQty(t.qty, spec.qtyStep) : "—"}</div>
            </div>
          </div>
        ) : (
          <NumField label="Quantity" value={draft.qty} step={spec.qtyStep} onChange={(v) => set({ qty: v })} />
        )}
      </div>

      <div className="space-y-1 rounded-md border border-line p-2 text-[12px]">
        <Row k="Risk" v={t.risk != null ? `${fmtMoney(t.risk)} (${((t.risk / equity) * 100).toFixed(2)}%)` : "—"} />
        <Row k="Reward" v={t.reward != null ? fmtMoney(t.reward) : "—"} />
        <Row k="R:R" v={t.rr != null ? `1 : ${t.rr.toFixed(2)}` : "—"} />
        <Row k="Notional" v={t.notional != null ? fmtMoney(t.notional) : "—"} />
        <Row k="Est. fees (round trip)" v={t.fees != null ? fmtMoney(t.fees) : "—"} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="label">Strategy</span>
          <select className="input" value={draft.strategyId ?? ""} onChange={(e) => set({ strategyId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Session default</option>
            {strategies
              .filter((s) => !s.archived)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Entry note</span>
          <input className="input" value={draft.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} placeholder="why?" />
        </label>
      </div>

      {(disabledReason || t.levelError || (draft.sizing === "risk" && t.sizingError)) && (
        <p className="text-[12px] text-warn">{disabledReason ?? t.levelError ?? t.sizingError}</p>
      )}

      <button
        disabled={!canSubmit}
        className={`btn w-full py-2 ${long ? "btn-buy" : "btn-sell"}`}
        onClick={() => onSubmit({ side: draft.side, type: draft.type, qty: t.qty, price: draft.type === "market" ? null : draft.entry, sl: draft.sl, tp: draft.tp })}
      >
        {submitting ? "Sending…" : `${long ? "Buy" : "Sell"} ${t.qty > 0 ? fmtQty(t.qty, spec.qtyStep) : ""} ${draft.type === "market" ? "at market" : `${draft.type} @ ${fmtPrice(draft.entry, spec.tickSize)}`}`}
      </button>
      <p className="text-[11px] leading-relaxed text-faint">
        Chart: <b className="font-medium text-muted">Alt+click</b> entry · <b className="font-medium text-muted">Shift+click</b> SL ·{" "}
        <b className="font-medium text-muted">Ctrl+click</b> TP · drag lines to adjust.
      </p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}
