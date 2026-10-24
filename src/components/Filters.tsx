"use client";

import { TIMEFRAMES } from "@/lib/market/timeframes";
import type { Strategy } from "@/lib/client/types";

export interface FilterState {
  symbol: string;
  strategyId: string;
  timeframe: string;
  mode: string;
  direction: string;
  from: string;
  to: string;
}

export const emptyFilters: FilterState = { symbol: "", strategyId: "", timeframe: "", mode: "", direction: "", from: "", to: "" };

export function filterQuery(f: FilterState): Record<string, string | number | undefined> {
  return {
    symbol: f.symbol || undefined,
    strategyId: f.strategyId || undefined,
    timeframe: f.timeframe || undefined,
    mode: f.mode || undefined,
    direction: f.direction || undefined,
    from: f.from ? Date.parse(`${f.from}T00:00:00Z`) : undefined,
    to: f.to ? Date.parse(`${f.to}T23:59:59.999Z`) : undefined,
  };
}

/** One row of filters shared by the journal and analytics pages. */
export function Filters({ value, onChange, strategies, symbols }: { value: FilterState; onChange: (f: FilterState) => void; strategies: Strategy[]; symbols: string[] }) {
  const set = (k: keyof FilterState) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  const active = Object.values(value).some(Boolean);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Symbol">
        <select className="input w-[120px]" value={value.symbol} onChange={set("symbol")}>
          <option value="">All</option>
          {symbols.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </Field>
      <Field label="Strategy">
        <select className="input w-[150px]" value={value.strategyId} onChange={set("strategyId")}>
          <option value="">All</option>
          <option value="none">(untagged)</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Timeframe">
        <select className="input w-[90px]" value={value.timeframe} onChange={set("timeframe")}>
          <option value="">All</option>
          {TIMEFRAMES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Mode">
        <select className="input w-[120px]" value={value.mode} onChange={set("mode")}>
          <option value="">All</option>
          <option value="historical">Historical</option>
          <option value="live">Live paper</option>
        </select>
      </Field>
      <Field label="Side">
        <select className="input w-[90px]" value={value.direction} onChange={set("direction")}>
          <option value="">All</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
      </Field>
      <Field label="Exit from (UTC)">
        <input className="input w-[140px]" type="date" value={value.from} onChange={set("from")} />
      </Field>
      <Field label="Exit to (UTC)">
        <input className="input w-[140px]" type="date" value={value.to} onChange={set("to")} />
      </Field>
      {active && (
        <button className="btn btn-ghost" onClick={() => onChange(emptyFilters)}>
          Clear
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
