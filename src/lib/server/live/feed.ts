/**
 * Live paper-trading feed manager (server-side, single process, multi-provider).
 *
 * - One stream connection per provider (Binance klines, OANDA/Alpaca quotes) with a
 *   dynamic stream set covering every instrument with live exposure or an open chart.
 * - Converts price updates into small "segments" and runs the shared execution engine
 *   on them for every live account with exposure on that instrument.
 *     · kline providers: each update carries the minute's cumulative high/low; a
 *       segment's extreme is the new high/low only if it extended since the previous
 *       update, otherwise only the span between the two closes is certain.
 *     · quote providers: each quote is a point; a segment spans the previous and the
 *       current mid, with the observed bid/ask spread.
 * - Segments are only processed while the instrument's market session is open.
 * - Detects stale feeds and disconnects, reconnects with backoff, and on reconnect
 *   (or server start) reconciles the missed period from REST 1m candles. Fills made
 *   during reconciliation are flagged `reconciled_gap`. Nothing is fabricated: if
 *   data cannot be fetched the instrument stays "unreconciled" and is not processed.
 */
import { eq } from "drizzle-orm";
import { processBar } from "@/lib/engine/engine";
import type { Bar, ExecutionFlag } from "@/lib/engine/types";
import { marketStatus } from "@/lib/market/calendars";
import type { CandleUpdate, MarketDataProvider, QuoteUpdate, StreamConnection, StreamKey, StreamStatus } from "@/lib/market/provider";
import { barStart } from "@/lib/market/timeframes";
import type { Db } from "../db/client";
import { liveSymbolCursors } from "../db/schema";
import { getInstrument } from "../repo/market";
import { activeLiveInstruments, appendEvents, liveAccountsForInstrument, loadEngineState, persistEngineResult } from "../repo/trading";
import { buildLiveContext } from "./context";

export type FeedStatus = "idle" | "connecting" | "connected" | "stale" | "disconnected";

export interface SymbolStatus {
  price: number | null;
  /** Observed spread (quote providers). */
  spread: number | null;
  eventTime: number | null;
  receivedAt: number | null;
  reconciled: boolean;
  note: string | null;
  marketOpen: boolean;
  marketNote: string | null;
}

export type FeedEvent =
  | { type: "status"; provider: string; status: FeedStatus; detail: string | null; lastMessageAt: number | null; symbols: Record<string, SymbolStatus> }
  | { type: "candle"; instrument: string; timeframe: string; bar: Bar; closed: boolean }
  | { type: "price"; instrument: string; price: number; time: number }
  | { type: "account"; accountId: string; reason: string }
  | { type: "notice"; level: "info" | "warn"; message: string };

export interface LiveSnapshot {
  ok: boolean;
  reason: string | null;
  price: number | null;
  eventTime: number | null;
  status: FeedStatus;
}

interface InstState {
  id: string;
  provider: string;
  native: string;
  calendar: string;
  klineOpenTime: number | null;
  lastHigh: number;
  lastLow: number;
  lastClose: number;
  lastEventTime: number | null;
  price: number | null;
  spread: number | null;
  receivedAt: number | null;
  reconciled: boolean;
  reconciling: boolean;
  note: string | null;
  lastCursorWrite: number;
}

interface ProviderConn {
  conn: StreamConnection | null;
  status: FeedStatus;
  detail: string | null;
  lastMessageAt: number | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface LiveFeedOptions {
  getDb: () => Db;
  getProvider: (id: string) => MarketDataProvider;
  now?: () => number;
  staleAfterMs?: () => number;
  reconcileLookbackMs?: () => number;
  /** Start interval timers (disabled in tests, which call tick() manually). */
  timers?: boolean;
  log?: (msg: string) => void;
}

const RECONNECT_MAX_MS = 30_000;
const CURSOR_WRITE_MS = 15_000;
const FORCE_RECONNECT_AFTER_MS = 60_000;

export class LiveFeed {
  private conns = new Map<string, ProviderConn>();
  private watchers = new Map<number, { instrument: string; timeframe: string; send: (e: FeedEvent) => void }>();
  private nextWatcherId = 1;
  private active = new Set<string>();
  private insts = new Map<string, InstState>();
  /** Forming chart candles built from quotes: `${instrument}@${tf}`. */
  private forming = new Map<string, Bar>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  readonly now: () => number;

  constructor(private readonly opts: LiveFeedOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get db() {
    return this.opts.getDb();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.refreshActive();
    if (this.opts.timers !== false) this.interval = setInterval(() => this.tick(), 5_000);
  }

  stop() {
    this.started = false;
    if (this.interval) clearInterval(this.interval);
    for (const c of this.conns.values()) {
      if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
      c.conn?.close();
      c.conn = null;
      c.status = "idle";
    }
  }

  // ---------------------------------------------------------------- instruments

  private instState(id: string): InstState | null {
    const existing = this.insts.get(id);
    if (existing) return existing;
    const inst = getInstrument(this.db, id);
    if (!inst) return null;
    const st: InstState = {
      id,
      provider: inst.sourceId,
      native: inst.providerSymbol ?? this.opts.getProvider(inst.sourceId).nativeSymbol(inst.symbol),
      calendar: inst.calendar,
      klineOpenTime: null,
      lastHigh: 0,
      lastLow: 0,
      lastClose: 0,
      lastEventTime: null,
      price: null,
      spread: null,
      receivedAt: null,
      reconciled: false,
      reconciling: false,
      note: null,
      lastCursorWrite: 0,
    };
    this.insts.set(id, st);
    return st;
  }

  private byNative(provider: string, native: string): InstState | undefined {
    for (const st of this.insts.values()) if (st.provider === provider && st.native.toUpperCase() === native.toUpperCase()) return st;
    return undefined;
  }

  // ---------------------------------------------------------------- watchers

  watch(instrumentId: string, timeframe: string, send: (e: FeedEvent) => void): () => void {
    const id = this.nextWatcherId++;
    const st = this.instState(instrumentId);
    this.watchers.set(id, { instrument: instrumentId, timeframe, send });
    this.syncStreams();
    if (st) {
      send(this.statusEvent(st.provider));
      if (st.price != null) send({ type: "price", instrument: instrumentId, price: st.price, time: st.lastEventTime ?? 0 });
    }
    return () => {
      this.watchers.delete(id);
      this.syncStreams();
    };
  }

  private broadcast(e: FeedEvent, filter?: (w: { instrument: string; timeframe: string }) => boolean) {
    for (const w of this.watchers.values()) {
      if (filter && !filter(w)) continue;
      try {
        w.send(e);
      } catch {
        /* watcher gone */
      }
    }
  }

  private broadcastStatus(provider: string) {
    const ev = this.statusEvent(provider);
    this.broadcast(ev, (w) => this.insts.get(w.instrument)?.provider === provider);
  }

  // ---------------------------------------------------------------- streams

  /** Re-read which instruments have live exposure (call after every live command). */
  refreshActive() {
    const next = new Set(activeLiveInstruments(this.db));
    for (const id of next) {
      if (!this.active.has(id)) {
        const st = this.instState(id);
        // Newly active: start the processing cursor now; nothing earlier is relevant.
        if (st?.reconciled) this.writeCursor(id, st.lastEventTime ?? this.now(), true);
      }
    }
    this.active = next;
    this.syncStreams();
  }

  private conn(provider: string): ProviderConn {
    let c = this.conns.get(provider);
    if (!c) {
      c = { conn: null, status: "idle", detail: null, lastMessageAt: null, reconnectAttempts: 0, reconnectTimer: null };
      this.conns.set(provider, c);
    }
    return c;
  }

  private instrumentIds(): Set<string> {
    return new Set([...this.active, ...[...this.watchers.values()].map((w) => w.instrument)]);
  }

  private desired(provider: string): StreamKey[] {
    const kline = this.opts.getProvider(provider).capabilities().liveKind === "kline";
    const keys = new Map<string, StreamKey>();
    const add = (st: InstState, tf: string) => keys.set(`${st.native}@${tf}`, { symbol: st.native, timeframe: tf });
    for (const id of this.instrumentIds()) {
      const st = this.instState(id);
      if (st?.provider === provider) add(st, "1m");
    }
    if (kline) {
      for (const w of this.watchers.values()) {
        const st = this.insts.get(w.instrument);
        if (st?.provider === provider) add(st, w.timeframe);
      }
    }
    return [...keys.values()];
  }

  private syncStreams() {
    if (!this.started) return;
    const providers = new Set<string>(this.conns.keys());
    for (const id of this.instrumentIds()) {
      const st = this.instState(id);
      if (st) providers.add(st.provider);
    }
    for (const provider of providers) {
      const c = this.conn(provider);
      const desired = this.desired(provider);
      if (desired.length === 0) {
        c.conn?.close();
        c.conn = null;
        this.setStatus(provider, "idle", null);
        continue;
      }
      if (!c.conn) {
        if (!c.reconnectTimer) this.connect(provider);
        continue;
      }
      c.conn.setStreams(desired);
      if (c.status === "connected") {
        for (const st of this.insts.values()) {
          if (st.provider === provider && !st.reconciled && !st.reconciling && desired.some((k) => k.symbol === st.native)) void this.reconcile(st.id);
        }
      }
    }
  }

  private connect(provider: string) {
    const p = this.opts.getProvider(provider);
    const c = this.conn(provider);
    const caps = p.capabilities();
    if (!p.openStream || !caps.live) {
      this.setStatus(provider, "disconnected", `${p.name} has no live feed`);
      return;
    }
    if (!caps.configured) {
      this.setStatus(provider, "disconnected", `${p.name} is not configured`);
      return;
    }
    const desired = this.desired(provider);
    if (desired.length === 0) return;
    this.setStatus(provider, "connecting", null);
    c.conn = p.openStream(desired, {
      onCandle: (u) => this.onCandle(provider, u),
      onQuote: (q) => this.onQuote(provider, q),
      onStatus: (s, d) => this.onStreamStatus(provider, s, d),
    });
  }

  private onStreamStatus(provider: string, s: StreamStatus, detail?: string) {
    const c = this.conn(provider);
    if (s === "connected") {
      c.reconnectAttempts = 0;
      c.lastMessageAt = this.now();
      this.setStatus(provider, "connected", null);
      for (const st of this.insts.values()) {
        if (st.provider === provider && !st.reconciled && !st.reconciling) void this.reconcile(st.id);
      }
    } else if (s === "disconnected") {
      c.conn = null;
      this.markUnreconciled(provider, detail ?? "disconnected");
      this.setStatus(provider, "disconnected", detail ?? null);
      this.scheduleReconnect(provider);
    } else {
      this.setStatus(provider, "connecting", detail ?? null);
    }
  }

  private markUnreconciled(provider: string, note: string) {
    for (const st of this.insts.values()) {
      if (st.provider !== provider) continue;
      st.reconciled = false;
      st.klineOpenTime = null;
      st.lastEventTime = null;
      st.note = note;
    }
  }

  private scheduleReconnect(provider: string) {
    const c = this.conn(provider);
    if (c.reconnectTimer || !this.started || this.desired(provider).length === 0) return;
    if (!this.opts.getProvider(provider).capabilities().configured) return;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** c.reconnectAttempts);
    c.reconnectAttempts++;
    c.reconnectTimer = setTimeout(() => {
      c.reconnectTimer = null;
      if (!c.conn) this.connect(provider);
    }, delay);
  }

  /** Periodic housekeeping: staleness detection, forced reconnects, cursor writes. */
  tick() {
    const now = this.now();
    const staleAfter = this.opts.staleAfterMs?.() ?? 20_000;
    for (const [provider, c] of this.conns) {
      if (!c.conn || c.lastMessageAt == null) continue;
      // Quote feeds are legitimately silent while every subscribed market is closed.
      const anyOpen = [...this.insts.values()].some((st) => st.provider === provider && marketStatus(st.calendar, now).open);
      if (!anyOpen) continue;
      const silent = now - c.lastMessageAt;
      if (silent > FORCE_RECONNECT_AFTER_MS) {
        this.opts.log?.(`[live] ${provider}: no data for ${Math.round(silent / 1000)}s — reconnecting`);
        c.conn.close();
        c.conn = null;
        this.markUnreconciled(provider, "silent feed");
        this.setStatus(provider, "disconnected", "no data received; reconnecting");
        this.scheduleReconnect(provider);
      } else if (silent > staleAfter && c.status === "connected") {
        this.setStatus(provider, "stale", `no data for ${Math.round(silent / 1000)}s`);
      }
    }
    for (const st of this.insts.values()) {
      if (this.active.has(st.id) && st.reconciled && st.lastEventTime && now - st.lastCursorWrite > CURSOR_WRITE_MS) this.writeCursor(st.id, st.lastEventTime);
    }
    for (const provider of this.conns.keys()) this.broadcastStatus(provider);
  }

  private touch(provider: string) {
    const c = this.conn(provider);
    c.lastMessageAt = this.now();
    if (c.status === "stale" || c.status === "connecting") this.setStatus(provider, "connected", null);
  }

  // ---------------------------------------------------------------- kline data

  /** Exposed for tests; normally called by the provider stream. */
  onCandle(provider: string, u: CandleUpdate) {
    this.touch(provider);
    const st = this.byNative(provider, u.symbol);
    if (!st) return;
    // Quote providers build their own chart candles from quotes.
    if (this.opts.getProvider(provider).capabilities().liveKind !== "kline") return;
    if (u.timeframe === "1m") {
      st.price = u.bar.close;
      st.receivedAt = this.now();
      if (st.reconciled) this.onMinuteUpdate(st, u);
      this.broadcast({ type: "price", instrument: st.id, price: u.bar.close, time: u.eventTime }, (w) => w.instrument === st.id);
    }
    this.broadcast({ type: "candle", instrument: st.id, timeframe: u.timeframe, bar: u.bar, closed: u.closed }, (w) => w.instrument === st.id && w.timeframe === u.timeframe);
  }

  private onMinuteUpdate(st: InstState, u: CandleUpdate) {
    const b = u.bar;
    if (st.klineOpenTime == null || st.lastEventTime == null) {
      this.seed(st, b, u.eventTime);
      return;
    }
    if (b.time < st.klineOpenTime) return; // out-of-order frame
    if (b.time > st.klineOpenTime + 60_000) {
      // Whole minutes were missed while connected: fill from REST instead of guessing.
      st.reconciled = false;
      st.note = "missed minutes in stream";
      void this.reconcile(st.id);
      return;
    }
    const open = st.lastClose;
    let high: number;
    let low: number;
    if (b.time === st.klineOpenTime) {
      high = b.high > st.lastHigh ? b.high : Math.max(open, b.close);
      low = b.low < st.lastLow ? b.low : Math.min(open, b.close);
    } else {
      // New minute: everything in it so far happened after the previous update.
      high = Math.max(open, b.high);
      low = Math.min(open, b.low);
    }
    const segment: Bar = {
      time: st.lastEventTime,
      open,
      high: Math.max(high, open, b.close),
      low: Math.min(low, open, b.close),
      close: b.close,
      volume: 0,
      end: Math.max(u.eventTime, st.lastEventTime),
    };
    this.seed(st, b, u.eventTime);
    if (this.active.has(st.id)) this.processSegment(st, segment, []);
    if (u.closed && this.active.has(st.id)) this.writeCursor(st.id, u.eventTime);
  }

  private seed(st: InstState, b: Bar, eventTime: number) {
    st.klineOpenTime = b.time;
    st.lastHigh = b.high;
    st.lastLow = b.low;
    st.lastClose = b.close;
    st.lastEventTime = eventTime;
  }

  // ---------------------------------------------------------------- quote data

  /** Exposed for tests; normally called by the provider stream. */
  onQuote(provider: string, q: QuoteUpdate) {
    this.touch(provider);
    const st = this.byNative(provider, q.symbol);
    if (!st || !(q.bid > 0) || !(q.ask >= q.bid)) return;
    const mid = (q.bid + q.ask) / 2;
    const spread = q.ask - q.bid;
    st.spread = spread;
    st.receivedAt = this.now();
    if (st.reconciled) {
      const prevTime = st.lastEventTime;
      const prevMid = st.lastClose;
      if (prevTime != null && prevMid > 0 && q.time >= prevTime) {
        const segment: Bar = { time: prevTime, open: prevMid, high: Math.max(prevMid, mid), low: Math.min(prevMid, mid), close: mid, volume: 0, end: q.time, spread };
        if (this.active.has(st.id)) this.processSegment(st, segment, []);
      }
      st.lastEventTime = Math.max(q.time, prevTime ?? 0);
      st.lastClose = mid;
    }
    st.price = mid;
    this.updateForming(st, mid, q.time);
    this.broadcast({ type: "price", instrument: st.id, price: mid, time: q.time }, (w) => w.instrument === st.id);
  }

  /** Build chart candles from quote mids for each watched timeframe. */
  private updateForming(st: InstState, mid: number, time: number) {
    const tfs = new Set([...this.watchers.values()].filter((w) => w.instrument === st.id).map((w) => w.timeframe));
    for (const tf of tfs) {
      const key = `${st.id}@${tf}`;
      const bucket = barStart(time, tf);
      let bar = this.forming.get(key);
      if (bar && bar.time !== bucket) {
        this.broadcast({ type: "candle", instrument: st.id, timeframe: tf, bar, closed: true }, (w) => w.instrument === st.id && w.timeframe === tf);
        bar = undefined;
      }
      if (!bar) bar = { time: bucket, open: mid, high: mid, low: mid, close: mid, volume: 0 };
      else {
        bar.high = Math.max(bar.high, mid);
        bar.low = Math.min(bar.low, mid);
        bar.close = mid;
      }
      this.forming.set(key, bar);
      this.broadcast({ type: "candle", instrument: st.id, timeframe: tf, bar: { ...bar }, closed: false }, (w) => w.instrument === st.id && w.timeframe === tf);
    }
  }

  // ---------------------------------------------------------------- execution

  private processSegment(st: InstState, bar: Bar, flags: ExecutionFlag[]) {
    const db = this.db;
    // No execution while the session is closed (weekends, after hours, holidays).
    if (!marketStatus(st.calendar, bar.end ?? bar.time).open) return;
    const accounts = liveAccountsForInstrument(db, st.id);
    if (accounts.length === 0) return;
    const instrument = getInstrument(db, st.id);
    if (!instrument) return;
    const reconciled = flags.includes("reconciled_gap");
    let changed = false;
    for (const accountId of accounts) {
      const built = buildLiveContext(db, accountId, instrument, this.prices(), bar.end ?? bar.time);
      if ("error" in built) {
        st.note = built.error;
        continue;
      }
      const r = processBar(loadEngineState(db, accountId, instrument.symbol), bar, built.ctx, { flags });
      if (r.executions.length === 0 && r.orders.length === 0 && r.positions.length === 0) continue;
      db.transaction((tx) =>
        persistEngineResult(
          tx,
          {
            accountId,
            sessionId: null,
            instrumentId: instrument.id,
            mode: "live",
            dataSource: reconciled
              ? `${instrument.sourceId}-rest:1m`
              : this.opts.getProvider(instrument.sourceId).capabilities().liveKind === "quote"
                ? `${instrument.sourceId}-stream:quotes`
                : `${instrument.sourceId}-ws:kline_1m`,
            dataVersion: reconciled ? "reconciled-after-gap" : "live-stream",
            quoteCurrency: instrument.quoteAsset,
          },
          r,
        ),
      );
      changed = true;
      this.broadcast({ type: "account", accountId, reason: "fill" });
    }
    if (changed) this.refreshActive();
  }

  private writeCursor(instrumentId: string, time: number, force = false) {
    const st = this.insts.get(instrumentId);
    // live_symbol_cursors.symbol holds the instrument id (e.g. "binance:BTCUSDT").
    const row = this.db.select().from(liveSymbolCursors).where(eq(liveSymbolCursors.symbol, instrumentId)).get();
    if (row && row.processedUntil >= time && !force) return;
    this.db
      .insert(liveSymbolCursors)
      .values({ symbol: instrumentId, processedUntil: time, lastPrice: st?.price ?? null, updatedAt: this.now() })
      .onConflictDoUpdate({ target: liveSymbolCursors.symbol, set: { processedUntil: time, lastPrice: st?.price ?? null, updatedAt: this.now() } })
      .run();
    if (st) st.lastCursorWrite = this.now();
  }

  private logEvent(accounts: string[], instrumentId: string, type: string, payload: Record<string, unknown>) {
    for (const accountId of accounts) {
      this.db.transaction((tx) => appendEvents(tx, accountId, null, [{ type, simTime: this.now(), payload: { instrument: instrumentId, ...payload } }]));
    }
  }

  /**
   * Replay the period since the last processed time from REST 1m candles, then
   * resume streaming. Without exposure on the instrument there is nothing to reconcile.
   */
  async reconcile(instrumentId: string): Promise<void> {
    const st = this.instState(instrumentId);
    const instrument = getInstrument(this.db, instrumentId);
    if (!st || !instrument || st.reconciling) return;
    st.reconciling = true;
    st.reconciled = false;
    try {
      const now = this.now();
      const row = this.db.select().from(liveSymbolCursors).where(eq(liveSymbolCursors.symbol, instrumentId)).get();
      const exposed = this.active.has(instrumentId);
      if (exposed && row && now - row.processedUntil > 3_000) {
        // Captured before replaying: fills during reconciliation may remove exposure,
        // but those accounts still need the audit record.
        const accounts = liveAccountsForInstrument(this.db, instrumentId);
        let from = row.processedUntil;
        const lookback = now - (this.opts.reconcileLookbackMs?.() ?? 72 * 3_600_000);
        if (from < lookback) {
          this.logEvent(accounts, instrumentId, "feed_gap_unreconciled", { from, to: lookback, reason: "beyond reconcile lookback" });
          this.broadcast({ type: "notice", level: "warn", message: `${instrument.symbol}: data before ${new Date(lookback).toISOString()} was not reconciled (outside lookback).` });
          from = lookback;
        }
        const provider = this.opts.getProvider(st.provider);
        const closed = await provider.fetchCandles(instrument.symbol, "1m", barStart(from, "1m"), now);
        const recent = await provider.fetchRecent(instrument.symbol, "1m", 2);
        const lastClosedTime = closed.length ? closed[closed.length - 1].time : -1;
        const formingBar = recent.filter((b) => b.time > lastClosedTime).pop();
        let missing = 0;
        for (let i = 1; i < closed.length; i++) missing += Math.max(0, Math.round((closed[i].time - closed[i - 1].time) / 60_000) - 1);
        for (const bar of closed) this.processSegment(st, { ...bar, end: bar.time + 60_000 }, ["reconciled_gap"]);
        if (formingBar) this.processSegment(st, { ...formingBar, end: now }, ["reconciled_gap"]);
        this.logEvent(accounts, instrumentId, "feed_reconciled", { from: row.processedUntil, to: now, bars: closed.length + (formingBar ? 1 : 0), missingMinutes: missing });
        if (missing > 0) this.logEvent(accounts, instrumentId, "feed_gap", { from: row.processedUntil, to: now, missingMinutes: missing });
        this.broadcast({
          type: "notice",
          level: "warn",
          message: `${instrument.symbol}: reconciled ${Math.round((now - row.processedUntil) / 1000)}s of missed data from 1m candles. Fills in that window are approximate and flagged.`,
        });
        const seedBar = formingBar ?? closed[closed.length - 1];
        if (seedBar) this.seed(st, seedBar, now);
      } else {
        // First stream update seeds the state.
        st.klineOpenTime = null;
        st.lastEventTime = null;
      }
      st.reconciled = true;
      st.note = null;
      if (exposed) this.writeCursor(instrumentId, st.lastEventTime ?? now, true);
    } catch (err) {
      st.note = `reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log?.(`[live] ${instrumentId} ${st.note}`);
      if (this.opts.timers !== false) setTimeout(() => void this.reconcile(instrumentId), 10_000);
    } finally {
      st.reconciling = false;
      this.broadcastStatus(st.provider);
    }
  }

  // ---------------------------------------------------------------- queries

  snapshot(instrumentId: string): LiveSnapshot {
    const st = this.insts.get(instrumentId);
    const c = st ? this.conns.get(st.provider) : undefined;
    const status = c?.status ?? "idle";
    const staleAfter = this.opts.staleAfterMs?.() ?? 20_000;
    const base = { price: st?.price ?? null, eventTime: st?.lastEventTime ?? null, status };
    if (!st || st.price == null || st.receivedAt == null) return { ...base, ok: false, reason: "No live price received yet for this instrument" };
    if (status !== "connected") return { ...base, ok: false, reason: `Feed is ${status}${c?.detail ? ` (${c.detail})` : ""}` };
    if (this.now() - st.receivedAt > staleAfter) return { ...base, ok: false, reason: "Live price is stale" };
    if (!st.reconciled) return { ...base, ok: false, reason: st.note ? `Reconciling: ${st.note}` : "Reconciling missed data" };
    return { ...base, ok: true, reason: null };
  }

  /** Latest prices keyed by instrument id. */
  prices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const st of this.insts.values()) if (st.price != null) out[st.id] = st.price;
    return out;
  }

  /** Keep an instrument streamed without a UI watcher (e.g. a conversion pair). */
  ensureStreamed(instrumentId: string) {
    if (!this.instState(instrumentId)) return;
    if (![...this.watchers.values()].some((w) => w.instrument === instrumentId)) {
      this.watchers.set(this.nextWatcherId++, { instrument: instrumentId, timeframe: "1m", send: () => {} });
    }
    this.syncStreams();
  }

  statusEvent(provider: string): Extract<FeedEvent, { type: "status" }> {
    const c = this.conns.get(provider);
    const symbols: Record<string, SymbolStatus> = {};
    const now = this.now();
    for (const st of this.insts.values()) {
      if (st.provider !== provider) continue;
      const m = marketStatus(st.calendar, now);
      symbols[st.id] = {
        price: st.price,
        spread: st.spread,
        eventTime: st.lastEventTime,
        receivedAt: st.receivedAt,
        reconciled: st.reconciled,
        note: st.note,
        marketOpen: m.open,
        marketNote: m.reason,
      };
    }
    return { type: "status", provider, status: c?.status ?? "idle", detail: c?.detail ?? null, lastMessageAt: c?.lastMessageAt ?? null, symbols };
  }

  allStatus() {
    return [...this.conns.keys()].map((p) => this.statusEvent(p));
  }

  private setStatus(provider: string, status: FeedStatus, detail: string | null) {
    const c = this.conn(provider);
    if (c.status === status && c.detail === detail) return;
    c.status = status;
    c.detail = detail;
    this.broadcastStatus(provider);
  }
}
