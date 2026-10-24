/**
 * Live paper-trading feed manager (server-side, single process).
 *
 * - Holds one WebSocket to the provider with a dynamic stream set.
 * - Converts successive 1m kline updates into small price "segments" and runs the
 *   shared execution engine on them for every live account with exposure.
 * - Detects stale feeds and disconnects, reconnects with backoff, and on reconnect
 *   (or server start) reconciles the missed period from REST 1m candles. Fills made
 *   during reconciliation are flagged `reconciled_gap`. Nothing is fabricated: if
 *   data cannot be fetched the symbol stays "unreconciled" and is not processed.
 *
 * Segment construction: each kline update carries the cumulative high/low of the
 * current minute. Between two updates the price moved from the previous close to the
 * new close; the segment's extreme is the new kline high/low if it extended since the
 * last update, otherwise only the span between the two closes is certain.
 */
import { eq } from "drizzle-orm";
import { processBar } from "@/lib/engine/engine";
import type { Bar, ExecutionFlag } from "@/lib/engine/types";
import type { CandleUpdate, MarketDataProvider, StreamConnection, StreamKey, StreamStatus } from "@/lib/market/provider";
import { barStart } from "@/lib/market/timeframes";
import type { Db } from "../db/client";
import { liveSymbolCursors } from "../db/schema";
import { getInstrument, instrumentId } from "../repo/market";
import {
  accountCosts,
  activeLiveSymbols,
  appendEvents,
  getAccount,
  liveAccountsForSymbol,
  loadEngineState,
  persistEngineResult,
} from "../repo/trading";
import { specOf } from "../services/market-data";

export type FeedStatus = "idle" | "connecting" | "connected" | "stale" | "disconnected";

export type FeedEvent =
  | { type: "status"; status: FeedStatus; detail: string | null; lastMessageAt: number | null; symbols: Record<string, SymbolStatus> }
  | { type: "candle"; symbol: string; timeframe: string; bar: Bar; closed: boolean }
  | { type: "price"; symbol: string; price: number; time: number }
  | { type: "account"; accountId: string; reason: string }
  | { type: "notice"; level: "info" | "warn"; message: string };

export interface SymbolStatus {
  price: number | null;
  eventTime: number | null;
  receivedAt: number | null;
  reconciled: boolean;
  note: string | null;
}

export interface LiveSnapshot {
  ok: boolean;
  reason: string | null;
  price: number | null;
  eventTime: number | null;
  status: FeedStatus;
}

interface SymbolState {
  klineOpenTime: number | null;
  lastHigh: number;
  lastLow: number;
  lastClose: number;
  lastEventTime: number | null;
  price: number | null;
  receivedAt: number | null;
  reconciled: boolean;
  reconciling: boolean;
  note: string | null;
  lastCursorWrite: number;
}

export interface LiveFeedOptions {
  getDb: () => Db;
  provider: MarketDataProvider;
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
  private conn: StreamConnection | null = null;
  private status: FeedStatus = "idle";
  private detail: string | null = null;
  private lastMessageAt: number | null = null;
  private watchers = new Map<number, { symbol: string; timeframe: string; send: (e: FeedEvent) => void }>();
  private nextWatcherId = 1;
  private active = new Set<string>();
  private symbols = new Map<string, SymbolState>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.conn?.close();
    this.conn = null;
    this.setStatus("idle", null);
  }

  // ---------------------------------------------------------------- watchers

  watch(symbol: string, timeframe: string, send: (e: FeedEvent) => void): () => void {
    const id = this.nextWatcherId++;
    this.watchers.set(id, { symbol: symbol.toUpperCase(), timeframe, send });
    this.syncStreams();
    send(this.statusEvent());
    const st = this.symbols.get(symbol.toUpperCase());
    if (st?.price != null) send({ type: "price", symbol: symbol.toUpperCase(), price: st.price, time: st.lastEventTime ?? 0 });
    return () => {
      this.watchers.delete(id);
      this.syncStreams();
    };
  }

  private broadcast(e: FeedEvent, filter?: (w: { symbol: string; timeframe: string }) => boolean) {
    for (const w of this.watchers.values()) {
      if (filter && !filter(w)) continue;
      try {
        w.send(e);
      } catch {
        /* watcher gone */
      }
    }
  }

  // ---------------------------------------------------------------- streams

  /** Re-read which symbols have live exposure (call after every live command). */
  refreshActive() {
    const next = new Set(activeLiveSymbols(this.db));
    for (const s of next) {
      if (!this.active.has(s)) {
        // Newly active: start the processing cursor now; nothing earlier is relevant.
        const st = this.symbols.get(s);
        if (st?.reconciled) this.writeCursor(s, st.lastEventTime ?? this.now(), true);
      }
    }
    this.active = next;
    this.syncStreams();
  }

  private desiredStreams(): StreamKey[] {
    const keys = new Map<string, StreamKey>();
    const add = (symbol: string, timeframe: string) => keys.set(`${symbol}@${timeframe}`, { symbol, timeframe });
    for (const s of this.active) add(s, "1m");
    for (const w of this.watchers.values()) {
      add(w.symbol, "1m");
      add(w.symbol, w.timeframe);
    }
    return [...keys.values()];
  }

  private syncStreams() {
    if (!this.started) return;
    const desired = this.desiredStreams();
    for (const k of desired) {
      if (k.timeframe === "1m" && !this.symbols.has(k.symbol)) this.symbols.set(k.symbol, this.freshSymbol());
    }
    if (desired.length === 0) {
      if (this.conn) {
        this.conn.close();
        this.conn = null;
      }
      this.setStatus("idle", null);
      return;
    }
    if (!this.conn) {
      if (!this.reconnectTimer) this.connect();
      return;
    }
    this.conn.setStreams(desired);
    // New symbols on an existing connection need their own reconciliation.
    if (this.status === "connected") {
      for (const k of desired) {
        const st = this.symbols.get(k.symbol);
        if (k.timeframe === "1m" && st && !st.reconciled && !st.reconciling) void this.reconcile(k.symbol);
      }
    }
  }

  private freshSymbol(): SymbolState {
    return {
      klineOpenTime: null,
      lastHigh: 0,
      lastLow: 0,
      lastClose: 0,
      lastEventTime: null,
      price: null,
      receivedAt: null,
      reconciled: false,
      reconciling: false,
      note: null,
      lastCursorWrite: 0,
    };
  }

  private connect() {
    if (!this.opts.provider.openStream) throw new Error(`Provider ${this.opts.provider.id} has no streaming support`);
    const desired = this.desiredStreams();
    if (desired.length === 0) return;
    this.setStatus("connecting", null);
    this.conn = this.opts.provider.openStream(desired, {
      onCandle: (u) => this.onCandle(u),
      onStatus: (s, d) => this.onStreamStatus(s, d),
    });
  }

  private onStreamStatus(s: StreamStatus, detail?: string) {
    if (s === "connected") {
      this.reconnectAttempts = 0;
      this.lastMessageAt = this.now();
      this.setStatus("connected", null);
      for (const [symbol, st] of this.symbols) {
        if (!st.reconciled && !st.reconciling) void this.reconcile(symbol);
      }
    } else if (s === "disconnected") {
      this.conn = null;
      this.markAllUnreconciled(detail ?? "disconnected");
      this.setStatus("disconnected", detail ?? null);
      this.scheduleReconnect();
    } else {
      this.setStatus("connecting", detail ?? null);
    }
  }

  private markAllUnreconciled(note: string) {
    for (const st of this.symbols.values()) {
      st.reconciled = false;
      st.klineOpenTime = null;
      st.note = note;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.started || this.desiredStreams().length === 0) return;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.conn) this.connect();
    }, delay);
  }

  /** Periodic housekeeping: staleness detection and forced reconnects. */
  tick() {
    const now = this.now();
    const staleAfter = this.opts.staleAfterMs?.() ?? 20_000;
    if (this.conn && this.lastMessageAt != null) {
      const silent = now - this.lastMessageAt;
      if (silent > FORCE_RECONNECT_AFTER_MS) {
        this.opts.log?.(`[live] no data for ${Math.round(silent / 1000)}s — reconnecting`);
        this.conn.close();
        this.conn = null;
        this.markAllUnreconciled("silent feed");
        this.setStatus("disconnected", "no data received; reconnecting");
        this.scheduleReconnect();
      } else if (silent > staleAfter && this.status === "connected") {
        this.setStatus("stale", `no data for ${Math.round(silent / 1000)}s`);
      }
    }
    for (const [symbol, st] of this.symbols) {
      if (this.active.has(symbol) && st.reconciled && st.lastEventTime && now - st.lastCursorWrite > CURSOR_WRITE_MS) {
        this.writeCursor(symbol, st.lastEventTime);
      }
    }
    this.broadcast(this.statusEvent());
  }

  // ---------------------------------------------------------------- data

  /** Exposed for tests; normally called by the provider stream. */
  onCandle(u: CandleUpdate) {
    const now = this.now();
    this.lastMessageAt = now;
    if (this.status === "stale" || this.status === "connecting") this.setStatus("connected", null);
    const symbol = u.symbol.toUpperCase();

    if (u.timeframe === "1m") {
      const st = this.symbols.get(symbol) ?? this.freshSymbol();
      this.symbols.set(symbol, st);
      st.price = u.bar.close;
      st.receivedAt = now;
      if (st.reconciled) this.onMinuteUpdate(symbol, st, u);
      this.broadcast({ type: "price", symbol, price: u.bar.close, time: u.eventTime }, (w) => w.symbol === symbol);
    }
    this.broadcast(
      { type: "candle", symbol, timeframe: u.timeframe, bar: u.bar, closed: u.closed },
      (w) => w.symbol === symbol && w.timeframe === u.timeframe,
    );
  }

  private onMinuteUpdate(symbol: string, st: SymbolState, u: CandleUpdate) {
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
      void this.reconcile(symbol);
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
    if (this.active.has(symbol)) this.processSegment(symbol, segment, []);
    if (u.closed && this.active.has(symbol)) this.writeCursor(symbol, u.eventTime);
  }

  private seed(st: SymbolState, b: Bar, eventTime: number) {
    st.klineOpenTime = b.time;
    st.lastHigh = b.high;
    st.lastLow = b.low;
    st.lastClose = b.close;
    st.lastEventTime = eventTime;
  }

  private processSegment(symbol: string, bar: Bar, flags: ExecutionFlag[]) {
    const db = this.db;
    const accounts = liveAccountsForSymbol(db, symbol);
    if (accounts.length === 0) return;
    const instrument = getInstrument(db, instrumentId("binance", symbol));
    if (!instrument) return;
    const reconciled = flags.includes("reconciled_gap");
    let changed = false;
    for (const accountId of accounts) {
      const account = getAccount(db, accountId);
      if (!account) continue;
      const ctx = { spec: specOf(instrument), costs: accountCosts(account) };
      const r = processBar(loadEngineState(db, accountId, symbol), bar, ctx, { flags });
      if (r.executions.length === 0 && r.orders.length === 0 && r.positions.length === 0) continue;
      db.transaction((tx) =>
        persistEngineResult(
          tx,
          {
            accountId,
            sessionId: null,
            instrumentId: instrument.id,
            mode: "live",
            dataSource: reconciled ? "binance-rest:1m" : "binance-ws:kline_1m",
            dataVersion: reconciled ? "reconciled-after-gap" : "live-stream",
            markPrice: bar.close,
          },
          r,
        ),
      );
      changed = true;
      this.broadcast({ type: "account", accountId, reason: "fill" });
    }
    if (changed) this.refreshActive();
  }

  private writeCursor(symbol: string, time: number, force = false) {
    const st = this.symbols.get(symbol);
    const row = this.db.select().from(liveSymbolCursors).where(eq(liveSymbolCursors.symbol, symbol)).get();
    if (row && row.processedUntil >= time && !force) return;
    this.db
      .insert(liveSymbolCursors)
      .values({ symbol, processedUntil: time, lastPrice: st?.price ?? null, updatedAt: this.now() })
      .onConflictDoUpdate({ target: liveSymbolCursors.symbol, set: { processedUntil: time, lastPrice: st?.price ?? null, updatedAt: this.now() } })
      .run();
    if (st) st.lastCursorWrite = this.now();
  }

  private logEvent(accounts: string[], symbol: string, type: string, payload: Record<string, unknown>) {
    for (const accountId of accounts) {
      this.db.transaction((tx) => appendEvents(tx, accountId, null, [{ type, simTime: this.now(), payload: { symbol, ...payload } }]));
    }
  }

  /**
   * Replay the period since the last processed time from REST 1m candles, then
   * resume streaming. Without exposure on the symbol there is nothing to reconcile.
   */
  async reconcile(symbol: string): Promise<void> {
    const st = this.symbols.get(symbol) ?? this.freshSymbol();
    this.symbols.set(symbol, st);
    if (st.reconciling) return;
    st.reconciling = true;
    st.reconciled = false;
    try {
      const now = this.now();
      const row = this.db.select().from(liveSymbolCursors).where(eq(liveSymbolCursors.symbol, symbol)).get();
      const exposed = this.active.has(symbol);
      if (exposed && row && now - row.processedUntil > 3_000) {
        // Captured before replaying: fills during reconciliation may remove exposure,
        // but those accounts still need the audit record.
        const accounts = liveAccountsForSymbol(this.db, symbol);
        let from = row.processedUntil;
        const lookback = now - (this.opts.reconcileLookbackMs?.() ?? 72 * 3_600_000);
        if (from < lookback) {
          this.logEvent(accounts, symbol, "feed_gap_unreconciled", { from, to: lookback, reason: "beyond reconcile lookback" });
          this.broadcast({ type: "notice", level: "warn", message: `${symbol}: data before ${new Date(lookback).toISOString()} was not reconciled (outside lookback).` });
          from = lookback;
        }
        const closed = await this.opts.provider.fetchCandles(symbol, "1m", barStart(from, "1m"), now);
        const recent = await this.opts.provider.fetchRecent(symbol, "1m", 2);
        const lastClosedTime = closed.length ? closed[closed.length - 1].time : -1;
        const forming = recent.filter((b) => b.time > lastClosedTime).pop();
        let missing = 0;
        for (let i = 1; i < closed.length; i++) missing += Math.max(0, Math.round((closed[i].time - closed[i - 1].time) / 60_000) - 1);
        for (const bar of closed) this.processSegment(symbol, bar, ["reconciled_gap"]);
        if (forming) this.processSegment(symbol, { ...forming, end: now }, ["reconciled_gap"]);
        this.logEvent(accounts, symbol, "feed_reconciled", { from: row.processedUntil, to: now, bars: closed.length + (forming ? 1 : 0), missingMinutes: missing });
        if (missing > 0) this.logEvent(accounts, symbol, "feed_gap", { from: row.processedUntil, to: now, missingMinutes: missing });
        this.broadcast({
          type: "notice",
          level: "warn",
          message: `${symbol}: reconciled ${Math.round((now - row.processedUntil) / 1000)}s of missed data from 1m candles. Fills in that window are approximate and flagged.`,
        });
        const seedBar = forming ?? closed[closed.length - 1];
        if (seedBar) this.seed(st, seedBar, now);
      } else {
        st.klineOpenTime = null; // first stream update seeds the state
      }
      st.reconciled = true;
      st.note = null;
      if (exposed) this.writeCursor(symbol, st.lastEventTime ?? now, true);
    } catch (err) {
      st.note = `reconciliation failed: ${err instanceof Error ? err.message : String(err)}`;
      this.opts.log?.(`[live] ${symbol} ${st.note}`);
      if (this.opts.timers !== false) setTimeout(() => void this.reconcile(symbol), 10_000);
    } finally {
      st.reconciling = false;
      this.broadcast(this.statusEvent());
    }
  }

  // ---------------------------------------------------------------- queries

  snapshot(symbol: string): LiveSnapshot {
    const st = this.symbols.get(symbol.toUpperCase());
    const staleAfter = this.opts.staleAfterMs?.() ?? 20_000;
    const base = { price: st?.price ?? null, eventTime: st?.lastEventTime ?? null, status: this.status };
    if (!st || st.price == null || st.receivedAt == null) return { ...base, ok: false, reason: "No live price received yet for this symbol" };
    if (this.status !== "connected") return { ...base, ok: false, reason: `Feed is ${this.status}${this.detail ? ` (${this.detail})` : ""}` };
    if (this.now() - st.receivedAt > staleAfter) return { ...base, ok: false, reason: "Live price is stale" };
    if (!st.reconciled) return { ...base, ok: false, reason: st.note ? `Reconciling: ${st.note}` : "Reconciling missed data" };
    return { ...base, ok: true, reason: null };
  }

  prices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [s, st] of this.symbols) if (st.price != null) out[s] = st.price;
    return out;
  }

  statusEvent(): Extract<FeedEvent, { type: "status" }> {
    const symbols: Record<string, SymbolStatus> = {};
    for (const [s, st] of this.symbols) {
      symbols[s] = { price: st.price, eventTime: st.lastEventTime, receivedAt: st.receivedAt, reconciled: st.reconciled, note: st.note };
    }
    return { type: "status", status: this.status, detail: this.detail, lastMessageAt: this.lastMessageAt, symbols };
  }

  private setStatus(status: FeedStatus, detail: string | null) {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.broadcast(this.statusEvent());
  }
}
