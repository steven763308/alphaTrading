"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CandleChart, type CandleChartHandle, type ChartClick, type ChartLine, type ChartMarker } from "@/components/CandleChart";
import { MarketPicker } from "@/components/MarketPicker";
import { Toasts } from "@/components/Toasts";
import { unrealizedPnl } from "@/lib/engine/math";
import type { Bar, Conversion, CostModel, InstrumentSpec } from "@/lib/engine/types";
import { conversionPair, resolveConversion } from "@/lib/market/conversion";
import { TIMEFRAMES, barStart } from "@/lib/market/timeframes";
import { ApiError, api, qs } from "@/lib/client/api";
import { fmtMoney, fmtTime, pnlClass } from "@/lib/client/format";
import { useNow, usePersistentState, useSettings, useStrategies, useToasts } from "@/lib/client/hooks";
import type { AppSettings, InstrumentRow, LiveState, OrderRow, PositionRow, SessionListItem, SessionView, TicketDraft } from "@/lib/client/types";
import { NewSessionDialog } from "./NewSessionDialog";
import { OrderTicket } from "./OrderTicket";
import { TradesPanel } from "./TradesPanel";

type Mode = "historical" | "live";
type Command = Record<string, unknown> & { kind: string };
type TapTool = "entry" | "sl" | "tp" | null;

const COLORS = { up: "#26a69a", down: "#ef5350", draft: "#3987e5", order: "#c3c2b7" };
const SPEEDS = [1, 2, 5, 10, 25, 60];

const emptyDraft = (riskPercent: number): TicketDraft => ({
  side: "buy",
  type: "market",
  entry: null,
  sl: null,
  tp: null,
  sizing: "risk",
  riskPercent,
  qty: null,
  strategyId: null,
  note: "",
});

/** Shape both modes expose to the shared chart/ticket UI. */
interface Trading {
  symbol: string;
  instrumentId: string;
  timeframe: string;
  spec: InstrumentSpec;
  unit: string;
  costs: CostModel;
  conversion: Conversion | undefined;
  accountCurrency: string;
  price: number | null;
  balance: number;
  startingBalance: number;
  /** Server-computed unrealized for positions not on the charted instrument. */
  serverUnrealized: Record<string, number>;
  openPositions: PositionRow[];
  pendingOrders: OrderRow[];
  closedPositions: PositionRow[];
  recentOrders: OrderRow[];
  flagsByPosition: Record<string, string[]>;
  prices: Record<string, number>;
  disabledReason: string | null;
  marketNote: string | null;
}

export function Simulator() {
  const { settings } = useSettings();
  if (!settings) return <div className="p-6 text-muted">Loading…</div>;
  return <SimulatorInner settings={settings} />;
}

function SimulatorInner({ settings }: { settings: AppSettings }) {
  const [mode, setMode] = usePersistentState<Mode>("tl.mode", "historical");
  // Deep links (?session=<id> or ?mode=live) win over the remembered mode. Declared after
  // usePersistentState so this effect runs after its storage load.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("session")) setMode("historical");
    else if (q.get("mode") === "live" || q.get("mode") === "historical") setMode(q.get("mode") as Mode);
  }, [setMode]);
  const { strategies } = useStrategies();
  const { toasts, push, dismiss } = useToasts();
  const chartRef = useRef<CandleChartHandle>(null);
  const [lastBarTime, setLastBarTime] = useState<number | null>(null);
  const [draft, setDraft] = useState<TicketDraft>(() => emptyDraft(settings.riskPercent));
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<TapTool>(null);
  const [panel, setPanel] = useState<"order" | "trades">("order");

  const hist = useHistorical(mode === "historical", chartRef, setLastBarTime, push);
  const live = useLive(mode === "live", settings, chartRef, setLastBarTime, push);
  const t: Trading | null = mode === "historical" ? hist.trading : live.trading;

  const unrealized = useMemo(() => {
    if (!t) return 0;
    let u = 0;
    for (const p of t.openPositions) {
      if (p.instrumentId === t.instrumentId) {
        const m = t.prices[p.instrumentId];
        if (m) u += unrealizedPnl(p.direction as "long" | "short", p.entryPrice, m, p.qty, t.spec, t.costs, t.conversion);
      } else u += t.serverUnrealized[p.id] ?? 0;
    }
    return u;
  }, [t]);
  const equity = t ? t.balance + unrealized : 0;
  const usedMargin = t ? t.openPositions.reduce((s, p) => s + (p.margin ?? 0), 0) : 0;

  const { command: histCommand, refresh: histRefresh } = hist;
  const { command: liveCommand, refresh: liveRefresh } = live;
  const hasTrading = t != null;
  const send = useCallback(
    async (cmd: Command) => {
      if (!hasTrading) return false;
      setBusy(true);
      try {
        const rejected = mode === "historical" ? await histCommand(cmd) : await liveCommand(cmd);
        if (rejected) push("error", `Order rejected: ${rejected}`);
        return !rejected;
      } catch (e) {
        push("error", e instanceof Error ? e.message : String(e));
        if (mode === "historical") void histRefresh();
        else void liveRefresh();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [hasTrading, mode, histCommand, liveCommand, histRefresh, liveRefresh, push],
  );

  // ---- chart lines -----------------------------------------------------------
  const lines = useMemo<ChartLine[]>(() => {
    if (!t) return [];
    const out: ChartLine[] = [];
    for (const p of t.openPositions) {
      if (p.instrumentId !== t.instrumentId) continue;
      const long = p.direction === "long";
      out.push({ id: `pos:${p.id}:entry`, price: p.entryPrice, color: long ? COLORS.up : COLORS.down, title: `${long ? "L" : "S"} ${p.qty}` });
      if (p.sl != null) out.push({ id: `pos:${p.id}:sl`, price: p.sl, color: COLORS.down, title: "SL", style: "dashed", draggable: true });
      if (p.tp != null) out.push({ id: `pos:${p.id}:tp`, price: p.tp, color: COLORS.up, title: "TP", style: "dashed", draggable: true });
    }
    for (const o of t.pendingOrders) {
      if (o.instrumentId !== t.instrumentId || o.price == null) continue;
      out.push({ id: `ord:${o.id}:price`, price: o.price, color: COLORS.order, title: `${o.side === "buy" ? "Buy" : "Sell"} ${o.type}`, style: "dashed", draggable: true });
      if (o.sl != null) out.push({ id: `ord:${o.id}:sl`, price: o.sl, color: COLORS.down, title: "SL", style: "dotted", draggable: true });
      if (o.tp != null) out.push({ id: `ord:${o.id}:tp`, price: o.tp, color: COLORS.up, title: "TP", style: "dotted", draggable: true });
    }
    if (draft.type !== "market" && draft.entry != null) out.push({ id: "draft:entry", price: draft.entry, color: COLORS.draft, title: "Entry", style: "dashed", draggable: true });
    if (draft.sl != null) out.push({ id: "draft:sl", price: draft.sl, color: COLORS.down, title: "New SL", style: "dotted", draggable: true });
    if (draft.tp != null) out.push({ id: "draft:tp", price: draft.tp, color: COLORS.up, title: "New TP", style: "dotted", draggable: true });
    return out;
  }, [t, draft]);

  const markers = useMemo<ChartMarker[]>(() => {
    if (!t || lastBarTime == null) return [];
    const snap = (time: number) => Math.min(barStart(time, t.timeframe), lastBarTime);
    const out: ChartMarker[] = [];
    for (const p of [...t.closedPositions, ...t.openPositions]) {
      if (p.instrumentId !== t.instrumentId) continue;
      const long = p.direction === "long";
      out.push({ time: snap(p.entryTime), position: long ? "belowBar" : "aboveBar", color: long ? COLORS.up : COLORS.down, shape: long ? "arrowUp" : "arrowDown" });
      if (p.exitTime != null) out.push({ time: snap(p.exitTime), position: long ? "aboveBar" : "belowBar", color: (p.netPnl ?? 0) >= 0 ? COLORS.up : COLORS.down, shape: "circle" });
    }
    return out;
  }, [t, lastBarTime]);

  const onLineDrag = useCallback((id: string, price: number) => {
    if (id.startsWith("draft:")) {
      const k = id.split(":")[1] as "entry" | "sl" | "tp";
      setDraft((d) => ({ ...d, [k]: price }));
    }
  }, []);

  const onLineDragEnd = useCallback(
    (id: string, price: number) => {
      const [kind, entityId, field] = id.split(":");
      if (kind === "pos") void send({ kind: "modify_position", positionId: entityId, [field]: price });
      if (kind === "ord") void send({ kind: "modify_order", orderId: entityId, [field]: price });
    },
    [send],
  );

  const marketPrice = t?.price ?? null;
  const onChartClick = useCallback(
    (c: ChartClick) => {
      if (marketPrice == null) return;
      // Touch: an active tap tool decides; mouse: Alt / Shift / Ctrl modifiers.
      const which: TapTool = tool ?? (c.alt ? "entry" : c.shift ? "sl" : c.ctrl ? "tp" : null);
      if (!which) return;
      if (which === "entry") {
        setDraft((d) => {
          const below = c.price < marketPrice;
          const type = d.side === "buy" ? (below ? "limit" : "stop") : below ? "stop" : "limit";
          return { ...d, entry: c.price, type };
        });
      } else setDraft((d) => ({ ...d, [which]: c.price }));
      setTool(null);
      setPanel("order");
    },
    [marketPrice, tool],
  );

  const submit = async (o: { side: "buy" | "sell"; type: TicketDraft["type"]; qty: number; price: number | null; sl: number | null; tp: number | null }) => {
    const ok = await send({ kind: "place", clientOrderId: crypto.randomUUID(), ...o, strategyId: draft.strategyId, entryNote: draft.note || null });
    if (ok) setDraft((d) => ({ ...emptyDraft(d.riskPercent), side: d.side, sizing: d.sizing, qty: d.qty, strategyId: d.strategyId }));
  };

  const realized = t ? t.balance - t.startingBalance : 0;
  const disabled = t ? (t.disabledReason ?? (draft.type === "market" && t.marketNote ? `Market closed: ${t.marketNote}. Pending orders are still accepted.` : null)) : null;

  const ticket = t ? (
    <OrderTicket
      draft={draft}
      onChange={setDraft}
      spec={t.spec}
      costs={t.costs}
      conversion={t.conversion}
      accountCurrency={t.accountCurrency}
      unit={t.unit}
      price={t.price}
      equity={equity}
      freeMargin={t.spec.leverage ? equity - usedMargin : null}
      strategies={strategies}
      disabledReason={disabled}
      submitting={busy}
      onSubmit={submit}
    />
  ) : (
    <p className="p-4 text-muted">The order ticket appears once market data is loaded.</p>
  );

  const trades = t ? (
    <TradesPanel
      openPositions={t.openPositions}
      pendingOrders={t.pendingOrders}
      closedPositions={t.closedPositions}
      recentOrders={t.recentOrders}
      flagsByPosition={t.flagsByPosition}
      prices={t.prices}
      instrumentId={t.instrumentId}
      spec={t.spec}
      costs={t.costs}
      conversion={t.conversion}
      serverUnrealized={t.serverUnrealized}
      timeZone={settings.timeZone}
      busy={busy}
      onClose={(id) => void send({ kind: "close", positionId: id })}
      onCancel={(id) => void send({ kind: "cancel", orderId: id })}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1.5 md:px-3">
        <div className="flex rounded-md bg-bg p-0.5">
          {(["historical", "live"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`whitespace-nowrap rounded px-3 py-1.5 ${mode === m ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}>
              {m === "historical" ? "Historical" : "Live Paper"}
            </button>
          ))}
        </div>
        {mode === "historical" ? hist.toolbar : live.toolbar}
        {t && (
          <div className="ml-auto flex items-center gap-4 text-[12px]">
            <Stat k={`Equity ${t.accountCurrency}`} v={fmtMoney(equity)} />
            <Stat k="Unrealized" v={fmtMoney(unrealized, { sign: true })} cls={pnlClass(unrealized)} />
            <span className="hidden sm:contents">
              <Stat k="Balance" v={fmtMoney(t.balance)} />
              <Stat k="Realized" v={fmtMoney(realized, { sign: true })} cls={pnlClass(realized)} />
              {t.spec.leverage ? <Stat k="Free margin" v={fmtMoney(equity - usedMargin)} /> : null}
            </span>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-[240px] flex-1">
            <CandleChart
              ref={chartRef}
              tickSize={t?.spec.tickSize ?? 0.01}
              timeZone={settings.timeZone}
              lines={lines}
              markers={markers}
              onLineDrag={onLineDrag}
              onLineDragEnd={onLineDragEnd}
              onChartClick={onChartClick}
              onNeedHistory={mode === "historical" ? hist.loadOlder : live.loadOlder}
            />
            {t && (
              <div className="absolute right-16 top-1.5 z-20 flex items-center gap-1">
                {tool && <span className="mr-1 hidden rounded bg-raised px-2 py-1 text-[11px] text-warn sm:inline">Tap the chart to set {tool.toUpperCase()}</span>}
                {(["entry", "sl", "tp"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setTool(tool === k ? null : k)}
                    className={`rounded border px-2 py-1 text-[11px] font-medium ${tool === k ? "border-warn bg-warn/15 text-warn" : "border-line-strong bg-panel/90 text-muted"}`}
                    title={`Tap, then tap the chart to set ${k.toUpperCase()}`}
                  >
                    {k === "entry" ? "Entry" : k.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            {!t && (
              <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center p-6 text-center text-muted">
                {mode === "historical" ? "Create or open a backtest session to start." : (live.unavailable ?? "Connecting to live market data…")}
              </div>
            )}
          </div>
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-t border-line px-2 py-1.5 md:px-3">
            {mode === "historical" ? hist.playback(settings.timeZone) : live.statusBar(settings.timeZone)}
          </div>
          <div className="hidden h-[220px] shrink-0 border-t border-line lg:block">{trades}</div>
        </div>

        <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-line bg-panel lg:block">{ticket}</aside>

        {/* Phones, Fold, iPad portrait: bottom panel */}
        <div className="flex h-[46%] min-h-[260px] shrink-0 flex-col border-t border-line bg-panel lg:hidden">
          <div className="flex shrink-0 border-b border-line">
            {(["order", "trades"] as const).map((k) => (
              <button key={k} onClick={() => setPanel(k)} className={`flex-1 py-2 ${panel === k ? "border-b-2 border-accent text-ink" : "text-muted"}`}>
                {k === "order" ? "Order" : `Trades${t ? ` (${t.openPositions.length + t.pendingOrders.length})` : ""}`}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{panel === "order" ? ticket : trades}</div>
        </div>
      </div>
      {hist.dialog(strategies, settings)}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="text-right leading-tight">
      <div className="text-[10px] text-muted">{k}</div>
      <div className={`num ${cls ?? ""}`}>{v}</div>
    </div>
  );
}

// =============================================================================
// Historical replay
// =============================================================================

function useHistorical(
  active: boolean,
  chartRef: React.RefObject<CandleChartHandle | null>,
  setLastBarTime: (t: number | null) => void,
  push: (k: "error" | "warn" | "info", t: string) => void,
) {
  const [sessionId, setSessionId] = usePersistentState<string | null>("tl.session", null);
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get("session");
    if (linked) setSessionId(linked);
  }, [setSessionId]);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [view, setView] = useState<SessionView | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = usePersistentState("tl.speed", 2);
  const [showNew, setShowNew] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const viewRef = useRef<SessionView | null>(null);
  // Keep the ref in sync synchronously so back-to-back requests use the latest revision.
  const applyView = useCallback((v: SessionView) => {
    viewRef.current = v;
    setView(v);
  }, []);
  const inflight = useRef(false);
  const historyState = useRef({ loading: false, exhausted: false });

  const loadSessions = useCallback(() => {
    api<SessionListItem[]>("/api/sessions").then(setSessions).catch(() => {});
  }, []);
  useEffect(loadSessions, [loadSessions]);

  // Load session + visible candles.
  useEffect(() => {
    if (!active || !sessionId) return;
    let cancelled = false;
    historyState.current = { loading: false, exhausted: false };
    (async () => {
      try {
        const [v, bars] = await Promise.all([api<SessionView>(`/api/sessions/${sessionId}`), api<Bar[]>(`/api/sessions/${sessionId}/candles?limit=1500`)]);
        if (cancelled) return;
        applyView(v);
        chartRef.current?.setData(bars);
        setLastBarTime(bars[bars.length - 1]?.time ?? null);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setSessionId(null);
        else push("error", e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, chartRef, setLastBarTime, setSessionId, push, applyView]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    applyView(await api<SessionView>(`/api/sessions/${sessionId}`));
  }, [sessionId, applyView]);

  const step = useCallback(
    async (n: number) => {
      const v = viewRef.current;
      if (!v || inflight.current) return false;
      inflight.current = true;
      try {
        const res = await api<{ applied: boolean; reason?: string; bars: Bar[]; view: SessionView }>(`/api/sessions/${v.session.id}/advance`, {
          method: "POST",
          json: { steps: n, revision: v.session.revision },
        });
        for (const b of res.bars) chartRef.current?.update(b);
        if (res.bars.length) setLastBarTime(res.bars[res.bars.length - 1].time);
        applyView(res.view);
        if (res.view.session.status === "completed") {
          setPlaying(false);
          if (res.applied) push("info", "Reached the end of the session range.");
          return false;
        }
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.conflict) {
          await refresh();
          return true;
        }
        push("error", e instanceof Error ? e.message : String(e));
        setPlaying(false);
        return false;
      } finally {
        inflight.current = false;
      }
    },
    [chartRef, setLastBarTime, push, refresh, applyView],
  );

  // Playback loop: one request at a time; high speeds batch several bars per request.
  useEffect(() => {
    if (!playing) return;
    let stop = false;
    (async () => {
      while (!stop) {
        const started = performance.now();
        const batch = speed > 10 ? Math.ceil(speed / 10) : 1;
        const interval = speed > 10 ? 100 : 1000 / speed;
        const ok = await step(batch);
        if (!ok || stop) break;
        const wait = interval - (performance.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
    return () => {
      stop = true;
    };
  }, [playing, speed, step]);

  // Keyboard: → / Space step, P play/pause.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        if (!playing) void step(1);
      } else if (e.key.toLowerCase() === "p") setPlaying((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, playing, step]);

  const loadOlder = useCallback(
    async (oldest: number) => {
      const v = viewRef.current;
      if (!v || historyState.current.loading || historyState.current.exhausted) return;
      historyState.current.loading = true;
      try {
        const bars = await api<Bar[]>(`/api/sessions/${v.session.id}/candles${qs({ before: oldest, limit: 1000 })}`);
        if (bars.length === 0) historyState.current.exhausted = true;
        else chartRef.current?.prepend(bars);
      } finally {
        historyState.current.loading = false;
      }
    },
    [chartRef],
  );

  const command = useCallback(
    async (cmd: Command) => {
      const v = viewRef.current!;
      const res = await api<{ rejected?: string | null; view: SessionView }>(`/api/sessions/${v.session.id}/commands`, { method: "POST", json: cmd });
      applyView(res.view);
      return res.rejected ?? null;
    },
    [applyView],
  );

  const verify = async () => {
    if (!view) return;
    setVerifying(true);
    try {
      const r = await api<{ ok: boolean; recordedExecutions: number; replayedExecutions: number; checksumMatches: boolean; recordedBalance: number; replayedBalance: number }>(
        `/api/sessions/${view.session.id}/verify`,
        { method: "POST" },
      );
      push(
        r.ok ? "info" : "error",
        r.ok
          ? `Replay verified: ${r.replayedExecutions} executions and final balance reproduced exactly; data checksum matches.`
          : `Replay mismatch: recorded ${r.recordedExecutions} fills / ${r.recordedBalance}, replayed ${r.replayedExecutions} / ${r.replayedBalance}. Checksum ${r.checksumMatches ? "ok" : "CHANGED"}.`,
      );
    } catch (e) {
      push("error", e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  };

  const trading: Trading | null = useMemo(() => {
    // A stale view from a previously selected session is never shown.
    if (!view || !active || view.session.id !== sessionId) return null;
    const i = view.instrument;
    const spec: InstrumentSpec = { symbol: i.symbol, tickSize: i.tickSize, qtyStep: i.qtyStep, minQty: i.minQty, contractSize: i.contractSize, leverage: view.leverage ?? undefined };
    return {
      symbol: i.symbol,
      instrumentId: i.id,
      timeframe: view.session.timeframe,
      spec,
      unit: i.unit,
      costs: view.costs,
      conversion: view.conversion,
      accountCurrency: view.account.currency,
      price: view.price || null,
      balance: view.account.balance,
      startingBalance: view.account.startingBalance,
      serverUnrealized: {},
      openPositions: view.openPositions,
      pendingOrders: view.pendingOrders,
      closedPositions: view.closedPositions,
      recentOrders: view.recentOrders,
      flagsByPosition: view.flagsByPosition,
      prices: { [i.id]: view.price },
      disabledReason: view.session.status === "completed" ? "Session completed — no further trading." : null,
      marketNote: null,
    };
  }, [view, active, sessionId]);

  const selectSession = (id: string | null) => {
    setPlaying(false);
    setSessionId(id);
  };

  const toolbar = (
    <>
      <select className="input order-last w-full sm:order-none sm:w-[300px]" value={sessionId ?? ""} onFocus={loadSessions} onChange={(e) => selectSession(e.target.value || null)}>
        <option value="">Select a session…</option>
        {sessions.map((s) => (
          <option key={s.session.id} value={s.session.id}>
            {s.session.name} · {s.trades} trades{s.session.status === "completed" ? " · done" : ""}
          </option>
        ))}
      </select>
      <button className="btn" onClick={() => setShowNew(true)}>
        New<span className="hidden sm:inline"> session</span>
      </button>
      {view && (
        <button
          className="btn btn-ghost hidden text-[12px] sm:inline-flex"
          onClick={async () => {
            if (!confirm(`Delete session "${view.session.name}" and all its trades?`)) return;
            await api(`/api/sessions/${view.session.id}`, { method: "DELETE" });
            selectSession(null);
            loadSessions();
          }}
        >
          Delete
        </button>
      )}
    </>
  );

  const playback = (timeZone: string) => {
    if (!view) return <span className="text-muted">No session loaded</span>;
    const pct = view.progress.total ? (view.progress.done / view.progress.total) * 100 : 0;
    const done = view.session.status === "completed";
    return (
      <>
        <button className="btn w-[72px]" disabled={done} onClick={() => setPlaying((p) => !p)} title="P">
          {playing ? "Pause" : "Play"}
        </button>
        <button className="btn" disabled={done || playing} onClick={() => void step(1)} title="→ or Space">
          Step ›
        </button>
        <button className="btn" disabled={done || playing} onClick={() => void step(10)}>
          +10
        </button>
        <select className="input w-[96px]" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Bars per second">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s} bar/s
            </option>
          ))}
        </select>
        <div className="mx-1 hidden h-1.5 w-32 overflow-hidden rounded bg-raised sm:block" title={`${view.progress.done}/${view.progress.total} bars`}>
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <span className="num text-[12px] text-muted">
          {view.progress.done}/{view.progress.total}
        </span>
        <span className="num text-[12px]">{fmtTime(view.simTime, timeZone)}</span>
        {view.warnings.length > 0 && (
          <span className="cursor-help text-[12px] text-warn" title={view.warnings.join("\n")} onClick={() => push("info", view.warnings.join(" · "))}>
            ⓘ {view.warnings.length}
          </span>
        )}
        <button className="btn btn-ghost ml-auto text-[12px]" disabled={verifying || playing} onClick={verify} title="Re-run the session from its command log and compare every fill">
          {verifying ? "Verifying…" : "Verify"}
        </button>
      </>
    );
  };

  const dialog = (strategies: Parameters<typeof NewSessionDialog>[0]["strategies"], settings: AppSettings) =>
    showNew ? (
      <NewSessionDialog
        settings={settings}
        strategies={strategies}
        onClose={() => setShowNew(false)}
        onCreated={(v) => {
          setShowNew(false);
          loadSessions();
          selectSession(v.session.id);
        }}
      />
    ) : null;

  return { trading, toolbar, playback, dialog, loadOlder, command, refresh };
}

// =============================================================================
// Live paper trading
// =============================================================================

type FeedStatusEvent = LiveState["feeds"][number];

interface LiveInfo {
  available: boolean;
  reason?: string | null;
  instrument?: InstrumentRow;
  instrumentId?: string;
  costs?: CostModel;
  session?: { open: boolean; reason: string | null };
  accountCurrency?: string;
  capabilities?: { name: string; delay: string; verification: string; notes: string[] } | null;
}

function useLive(
  active: boolean,
  settings: AppSettings,
  chartRef: React.RefObject<CandleChartHandle | null>,
  setLastBarTime: (t: number | null) => void,
  push: (k: "error" | "warn" | "info", t: string) => void,
) {
  const [symbol, setSymbol] = usePersistentState("tl.live.symbol", settings.defaultSymbol);
  const [timeframe, setTimeframe] = usePersistentState("tl.live.tf", settings.defaultTimeframe);
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [state, setState] = useState<LiveState | null>(null);
  const [feed, setFeed] = useState<FeedStatusEvent | null>(null);
  // Price is keyed by instrument so switching never shows the previous instrument's price.
  const [lastPrice, setLastPrice] = useState<{ id: string; price: number } | null>(null);
  const [sseOk, setSseOk] = useState(false);
  const now = useNow(1000);
  const historyState = useRef({ loading: false, exhausted: false });
  const instrumentId = info?.available ? info.instrumentId! : null;
  const price = lastPrice && lastPrice.id === instrumentId ? lastPrice.price : null;

  const refresh = useCallback(async () => {
    try {
      setState(await api<LiveState>("/api/live/state"));
    } catch {
      /* shown via status */
    }
  }, []);

  // Availability + spec for the chosen symbol.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api<LiveInfo>(`/api/live/instrument?symbol=${symbol}`)
      .then((i) => !cancelled && setInfo(i))
      .catch((e) => !cancelled && setInfo({ available: false, reason: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, [active, symbol]);

  // History + stream (only when a live source exists).
  useEffect(() => {
    if (!active || !instrumentId) return;
    let closed = false;
    historyState.current = { loading: false, exhausted: false };
    api<Bar[]>(`/api/market/candles${qs({ symbol, tf: timeframe, limit: 1000 })}`)
      .then((bars) => {
        if (closed) return;
        chartRef.current?.setData(bars);
        setLastBarTime(bars[bars.length - 1]?.time ?? null);
        if (bars.length) setLastPrice({ id: instrumentId, price: bars[bars.length - 1].close });
      })
      .catch((e) => push("error", `Could not load candles: ${e.message}`));

    const es = new EventSource(`/api/live/stream${qs({ symbol, tf: timeframe })}`);
    let accountTimer: ReturnType<typeof setTimeout> | null = null;
    es.onopen = () => setSseOk(true);
    es.onerror = () => setSseOk(false);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === "candle" && e.instrument === instrumentId && e.timeframe === timeframe) {
        chartRef.current?.update(e.bar);
        setLastBarTime(e.bar.time);
      } else if (e.type === "price" && e.instrument === instrumentId) setLastPrice({ id: instrumentId, price: e.price });
      else if (e.type === "status") setFeed(e);
      else if (e.type === "notice") push(e.level === "warn" ? "warn" : "info", e.message);
      else if (e.type === "account") {
        if (accountTimer) clearTimeout(accountTimer);
        accountTimer = setTimeout(refresh, 250);
      }
    };
    const first = setTimeout(refresh, 0);
    const poll = setInterval(refresh, 15_000);
    return () => {
      closed = true;
      es.close();
      clearTimeout(first);
      clearInterval(poll);
      if (accountTimer) clearTimeout(accountTimer);
      setSseOk(false);
    };
  }, [active, symbol, timeframe, instrumentId, chartRef, setLastBarTime, refresh, push]);

  const loadOlder = useCallback(
    async (oldest: number) => {
      if (historyState.current.loading || historyState.current.exhausted) return;
      historyState.current.loading = true;
      try {
        const bars = await api<Bar[]>(`/api/market/candles${qs({ symbol, tf: timeframe, limit: 1000, endTime: oldest - 1 })}`);
        if (bars.length === 0) historyState.current.exhausted = true;
        else chartRef.current?.prepend(bars);
      } finally {
        historyState.current.loading = false;
      }
    },
    [symbol, timeframe, chartRef],
  );

  const command = useCallback(
    async (cmd: Command) => {
      const res = await api<{ rejected: string | null; state: LiveState }>("/api/live/commands", { method: "POST", json: { ...cmd, symbol, timeframe } });
      setState(res.state);
      return res.rejected;
    },
    [symbol, timeframe],
  );

  const symStatus = instrumentId ? feed?.symbols?.[instrumentId] : undefined;
  const ageSec = symStatus?.receivedAt ? Math.max(0, Math.round((now - symStatus.receivedAt) / 1000)) : null;
  const marketOpen = symStatus?.marketOpen ?? info?.session?.open ?? true;
  const marketNote = marketOpen ? null : (symStatus?.marketNote ?? info?.session?.reason ?? "closed");
  const stale = marketOpen && (ageSec == null || ageSec > settings.staleAfterSeconds);
  let disabledReason: string | null = null;
  if (!sseOk) disabledReason = "Not connected to the app server stream.";
  else if (!feed || feed.status !== "connected") disabledReason = `Market data ${feed?.status ?? "connecting"}${feed?.detail ? ` (${feed.detail})` : ""} — trading paused.`;
  else if (stale) disabledReason = "Market data is stale — trading paused until fresh prices arrive.";
  else if (symStatus && !symStatus.reconciled) disabledReason = "Reconciling missed data…";

  const trading: Trading | null = useMemo(() => {
    if (!state || !info?.available || !info.instrument || !instrumentId || price == null) return null;
    const inst = info.instrument;
    const prices: Record<string, number> = { ...state.prices, [instrumentId]: price };
    const route = conversionPair(inst, state.account.currency);
    const conversion = resolveConversion(route, (pair) => prices[`${inst.sourceId}:${pair}`]) ?? undefined;
    return {
      symbol: inst.symbol,
      instrumentId,
      timeframe,
      spec: { symbol: inst.symbol, tickSize: inst.tickSize, qtyStep: inst.qtyStep, minQty: inst.minQty, contractSize: inst.contractSize, leverage: inst.leverage },
      unit: inst.unit,
      costs: info.costs!,
      conversion,
      accountCurrency: state.account.currency,
      price,
      balance: state.account.balance,
      startingBalance: state.account.startingBalance,
      serverUnrealized: state.unrealizedByPosition,
      openPositions: state.openPositions,
      pendingOrders: state.pendingOrders,
      closedPositions: state.closedPositions,
      recentOrders: state.recentOrders,
      flagsByPosition: state.flagsByPosition,
      prices,
      disabledReason: route?.kind === "rate" && !conversion ? `Waiting for a live ${route.pair} price to convert P&L…` : disabledReason,
      marketNote,
    };
  }, [state, info, instrumentId, price, timeframe, disabledReason, marketNote]);

  const unavailable = info && !info.available ? `Live data unavailable for ${symbol}. ${info.reason ?? ""}` : null;

  const toolbar = (
    <>
      <div className="order-last flex w-full gap-2 sm:order-none sm:w-auto">
        <MarketPicker mode="live" value={symbol} onChange={setSymbol} className="min-w-0 flex-1 sm:w-[180px] sm:flex-none" />
        <select className="input w-[76px]" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
          {TIMEFRAMES.map((tf) => (
            <option key={tf}>{tf}</option>
          ))}
        </select>
      </div>
    </>
  );

  const statusBar = (timeZone: string) => {
    if (unavailable) return <span className="text-[12px] text-warn">{unavailable}</span>;
    const good = sseOk && feed?.status === "connected" && !stale;
    return (
      <>
        <span className={`h-2 w-2 rounded-full ${good ? "bg-up" : feed?.status === "connecting" ? "bg-warn" : "bg-down"}`} />
        <span className="text-[12px]">
          {good ? "Live" : stale && feed?.status === "connected" ? "Stale" : !sseOk ? "server stream down" : (feed?.status ?? "connecting")}
          {feed?.detail ? ` · ${feed.detail}` : ""}
        </span>
        {info?.capabilities && <span className="hidden text-[12px] text-muted sm:inline">{info.capabilities.name}</span>}
        <span className={`rounded px-1.5 text-[11px] ${marketOpen ? "bg-up/15 text-up" : "bg-raised text-muted"}`} title={marketNote ?? "Regular session open"}>
          {marketOpen ? "Market open" : `Closed · ${marketNote}`}
        </span>
        <span className="num text-[12px] text-muted">
          {symStatus?.eventTime ? fmtTime(symStatus.eventTime, timeZone, true) : "—"}
          {ageSec != null ? ` (${ageSec}s)` : ""}
        </span>
        {symStatus?.note && <span className="text-[12px] text-warn">{symStatus.note}</span>}
        <span className="ml-auto hidden max-w-[460px] truncate text-[11px] text-faint xl:inline" title={state?.notice}>
          Monitored only while this app runs — offline execution needs an always-on service.
        </span>
      </>
    );
  };

  return { trading, toolbar, statusBar, loadOlder, command, refresh, unavailable };
}
