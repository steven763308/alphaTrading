"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";

export interface MarketInstrument {
  symbol: string;
  name: string;
  assetClass: string;
  unit: string;
  contractSize: number;
  leverage: number;
  session: { open: boolean; reason: string | null };
  historical: { provider: string | null; reason: string | null };
  live: { provider: string | null; reason: string | null };
}

export interface MarketsResponse {
  assetClasses: { id: string; label: string }[];
  instruments: MarketInstrument[];
}

let cache: Promise<MarketsResponse> | null = null;
export function loadMarkets(force = false): Promise<MarketsResponse> {
  if (!cache || force) cache = api<MarketsResponse>("/api/markets");
  return cache;
}

export function useMarkets() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  useEffect(() => {
    loadMarkets().then(setData).catch(() => {});
  }, []);
  return data;
}

const PROVIDER_LABEL: Record<string, string> = { binance: "Binance", dukascopy: "Dukascopy", oanda: "OANDA", alpaca: "Alpaca" };

/** Button showing the current symbol; opens the picker sheet. */
export function MarketPicker({
  mode,
  value,
  onChange,
  className = "",
}: {
  mode: "historical" | "live";
  value: string;
  onChange: (symbol: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const markets = useMarkets();
  const current = markets?.instruments.find((i) => i.symbol === value);
  return (
    <>
      <button className={`btn justify-between ${className}`} onClick={() => setOpen(true)} title="Choose market and instrument">
        <span className="num truncate">{value}</span>
        <span className="hidden truncate text-[11px] text-muted sm:inline">{current?.assetClass ?? ""}</span>
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 text-muted" fill="currentColor" aria-hidden>
          <path d="M5.5 7.5L10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </svg>
      </button>
      {open && (
        <MarketSheet
          mode={mode}
          value={value}
          onClose={() => setOpen(false)}
          onPick={(s) => {
            onChange(s);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function MarketSheet({ mode, value, onClose, onPick }: { mode: "historical" | "live"; value: string; onClose: () => void; onPick: (s: string) => void }) {
  const markets = useMarkets();
  const initialClass = markets?.instruments.find((i) => i.symbol === value)?.assetClass ?? "crypto";
  const [cls, setCls] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const activeClass = cls ?? initialClass;

  const list = useMemo(() => {
    const all = markets?.instruments ?? [];
    const query = q.trim().toUpperCase();
    return query ? all.filter((i) => i.symbol.includes(query) || i.name.toUpperCase().includes(query)) : all.filter((i) => i.assetClass === activeClass);
  }, [markets, q, activeClass]);

  const custom = q.trim().toUpperCase();
  const customValid = /^[A-Z0-9]{2,20}$/.test(custom) && !markets?.instruments.some((i) => i.symbol === custom);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60 md:items-center md:justify-center md:p-4" onMouseDown={onClose}>
      <div
        className="panel flex max-h-[88vh] w-full flex-col rounded-b-none pb-[env(safe-area-inset-bottom)] md:max-h-[80vh] md:max-w-xl md:rounded-b-lg md:pb-0"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line p-3">
          <input className="input" autoFocus placeholder="Search symbol or name (any Binance pair or US ticker)" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {!q && (
          <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
            {(markets?.assetClasses ?? []).filter((c) => markets?.instruments.some((i) => i.assetClass === c.id)).map((c) => (
              <button key={c.id} onClick={() => setCls(c.id)} className={`shrink-0 rounded-full px-3 py-1 ${activeClass === c.id ? "bg-accent text-white" : "bg-raised text-muted"}`}>
                {c.label}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {customValid && (
            <button className="flex w-full items-center justify-between border-b border-line px-4 py-3 text-left hover:bg-hover" onClick={() => onPick(custom)}>
              <span>
                Use <span className="num">{custom}</span>
              </span>
              <span className="text-[11px] text-muted">checked against providers when opened</span>
            </button>
          )}
          {list.map((i) => {
            const a = mode === "live" ? i.live : i.historical;
            return (
              <button
                key={i.symbol}
                onClick={() => onPick(i.symbol)}
                className={`flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left hover:bg-hover ${i.symbol === value ? "bg-raised" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="num font-medium">{i.symbol}</span>
                    <span className={`h-1.5 w-1.5 rounded-full ${i.session.open ? "bg-up" : "bg-faint"}`} title={i.session.open ? "Market open" : (i.session.reason ?? "Closed")} />
                  </div>
                  <div className="truncate text-[12px] text-muted">
                    {i.name} · {i.unit === "lot" ? `lot = ${i.contractSize.toLocaleString()}` : i.unit}
                    {i.leverage > 1 ? ` · 1:${i.leverage}` : ""}
                  </div>
                </div>
                {a.provider ? (
                  <span className="shrink-0 rounded bg-up/15 px-2 py-0.5 text-[11px] text-up">{PROVIDER_LABEL[a.provider] ?? a.provider}</span>
                ) : (
                  <span className="max-w-[45%] shrink-0 truncate rounded bg-raised px-2 py-0.5 text-[11px] text-muted" title={a.reason ?? ""}>
                    {mode === "live" ? "Live unavailable" : "No data source"}
                  </span>
                )}
              </button>
            );
          })}
          {list.length === 0 && !customValid && <p className="p-6 text-center text-muted">No matches.</p>}
        </div>
      </div>
    </div>
  );
}
