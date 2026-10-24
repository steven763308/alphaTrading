import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/lib/server/db/client";
import { executions, positions, tradeJournal } from "@/lib/server/db/schema";
import { getJournalEntry, journalCsv, listJournal, updateJournalAnnotations } from "@/lib/server/repo/journal";
import { DuplicateExecutionError, listExecutions, persistEngineResult } from "@/lib/server/repo/trading";
import {
  advanceSession,
  createSession,
  getSessionView,
  getVisibleCandles,
  listSessions,
  sessionCommand,
  verifyReplay,
} from "@/lib/server/services/backtest";
import { importCsv } from "@/lib/server/services/csv-import";
import { setProvider } from "@/lib/server/services/market-data";
import { FakeProvider } from "./fake-provider";
import { H1, HOUR } from "./helpers";

const FROM = Date.UTC(2024, 2, 4, 3); // first replayed bar: 03:00
const TO = Date.UTC(2024, 2, 5, 23);

let db: Db;
let provider: FakeProvider;

beforeEach(() => {
  db = openDb(":memory:").db;
  provider = new FakeProvider();
  setProvider("binance", provider);
});

async function newSession(opts: Partial<Parameters<typeof createSession>[1]> = {}) {
  return createSession(db, {
    source: "binance",
    symbol: "BTCUSDT",
    timeframe: "1h",
    from: FROM,
    to: TO,
    startingBalance: 10_000,
    costs: { makerFeeBps: 0, takerFeeBps: 0, spreadBps: 0, slippageBps: 0 },
    ...opts,
  });
}

async function step(id: string, steps = 1) {
  const rev = getSessionView(db, id).session.revision;
  return advanceSession(db, id, { steps, revision: rev });
}

describe("historical replay session", () => {
  it("starts at the last bar before the range and masks future candles", async () => {
    const v = await newSession();
    expect(v.session.cursorTime).toBe(Date.UTC(2024, 2, 4, 2));
    const visible = getVisibleCandles(db, v.session.id, { limit: 5000 });
    expect(visible.length).toBe(3); // 00:00, 01:00, 02:00 only
    expect(Math.max(...visible.map((b) => b.time))).toBe(v.session.cursorTime);
    // Asking for "before" a future time still never returns anything past the cursor.
    expect(getVisibleCandles(db, v.session.id, { before: TO + HOUR }).every((b) => b.time <= v.session.cursorTime)).toBe(true);

    const r = await step(v.session.id, 5);
    expect(r.applied).toBe(true);
    expect(r.bars.map((b) => b.time)).toEqual([3, 4, 5, 6, 7].map((h) => Date.UTC(2024, 2, 4, h)));
    expect(getVisibleCandles(db, v.session.id, {}).length).toBe(8);
  });

  it("ignores duplicate / stale advance requests (same revision)", async () => {
    const v = await newSession();
    const rev = v.session.revision;
    const first = await advanceSession(db, v.session.id, { steps: 1, revision: rev });
    const dup = await advanceSession(db, v.session.id, { steps: 1, revision: rev });
    expect(first.applied).toBe(true);
    expect(dup.applied).toBe(false);
    expect(dup.view.session.cursorTime).toBe(Date.UTC(2024, 2, 4, 3));
  });

  it("concurrent duplicate requests advance only once", async () => {
    const v = await newSession();
    const rev = v.session.revision;
    const results = await Promise.allSettled([
      advanceSession(db, v.session.id, { steps: 2, revision: rev }),
      advanceSession(db, v.session.id, { steps: 2, revision: rev }),
    ]);
    const applied = results.filter((r) => r.status === "fulfilled" && r.value.applied).length;
    expect(applied).toBe(1);
    expect(getSessionView(db, v.session.id).session.cursorTime).toBe(Date.UTC(2024, 2, 4, 4));
  });

  it("places orders idempotently per clientOrderId", async () => {
    const v = await newSession();
    const cmd = { kind: "place" as const, clientOrderId: "click-1", side: "buy" as const, type: "market" as const, qty: 0.1 };
    const a = sessionCommand(db, v.session.id, cmd);
    const b = sessionCommand(db, v.session.id, cmd);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(getSessionView(db, v.session.id).openPositions).toHaveLength(1);
  });

  it("resolves same-candle SL/TP with 1m data when enabled", async () => {
    const v = await newSession();
    await step(v.session.id, 5); // cursor at 07:00
    sessionCommand(db, v.session.id, { kind: "place", clientOrderId: "s1", side: "sell", type: "market", qty: 0.1, sl: 65_400, tp: 64_010 });
    await step(v.session.id, 1); // 08:00 touches both
    const j = listJournal(db, { sessionId: v.session.id }).rows[0];
    expect(j.exitReason).toBe("take_profit");
    expect(j.flags).toContain("resolved_lower_tf");
  });

  it("falls back to the conservative SL-first rule when lower-TF resolution is off", async () => {
    const v = await newSession({ resolveLowerTf: false });
    await step(v.session.id, 5);
    sessionCommand(db, v.session.id, { kind: "place", clientOrderId: "s1", side: "sell", type: "market", qty: 0.1, sl: 65_400, tp: 64_010 });
    await step(v.session.id, 1);
    const j = listJournal(db, { sessionId: v.session.id }).rows[0];
    expect(j.exitReason).toBe("stop_loss");
    expect(j.flags).toContain("ambiguous_sl_tp");
  });
});

/** A fixed script of trading actions used for determinism checks. */
async function runScript(id: string) {
  sessionCommand(db, id, { kind: "place", clientOrderId: "a", side: "buy", type: "limit", qty: 0.1, price: 63_400, sl: 63_000, tp: 64_000 });
  await step(id, 3);
  // No stop loss: stays open until the manual close below (excluded from R stats).
  sessionCommand(db, id, { kind: "place", clientOrderId: "b", side: "buy", type: "market", qty: 0.05 });
  await step(id, 4);
  sessionCommand(db, id, { kind: "place", clientOrderId: "c", side: "sell", type: "market", qty: 0.1, sl: 65_400, tp: 64_010 });
  await step(id, 10);
  const open = getSessionView(db, id).openPositions;
  for (const p of open) sessionCommand(db, id, { kind: "close", positionId: p.id });
  sessionCommand(db, id, { kind: "place", clientOrderId: "d", side: "buy", type: "limit", qty: 0.1, price: 60_000 });
  const pending = getSessionView(db, id).pendingOrders[0];
  sessionCommand(db, id, { kind: "cancel", orderId: pending.id });
  await step(id, 5);
}

describe("deterministic replay", () => {
  it("rebuilds identical executions and balance from the command log", async () => {
    const v = await newSession({ costs: { makerFeeBps: 10, takerFeeBps: 10, spreadBps: 1, slippageBps: 2 } });
    await runScript(v.session.id);
    expect(listExecutions(db, v.session.accountId).length).toBeGreaterThan(2);
    const check = await verifyReplay(db, v.session.id);
    expect(check.mismatches).toEqual({ missing: [], extra: [] });
    expect(check.ok).toBe(true);
    expect(check.checksumMatches).toBe(true);
  });

  it("two sessions running the same script produce the same fills", async () => {
    const a = await newSession();
    const b = await newSession();
    await runScript(a.session.id);
    await runScript(b.session.id);
    const strip = (accountId: string) =>
      listExecutions(db, accountId).map((e) => [e.kind, e.side, e.qty, e.price, e.fee, e.time, e.reason, e.flags.join("|")]);
    expect(strip(a.session.accountId)).toEqual(strip(b.session.accountId));
    expect(getSessionView(db, a.session.id).account.balance).toBe(getSessionView(db, b.session.id).account.balance);
  });
});

describe("journal consistency", () => {
  it("creates one journal row per closed position matching the execution facts", async () => {
    const v = await newSession({ costs: { makerFeeBps: 10, takerFeeBps: 10, spreadBps: 1, slippageBps: 2 } });
    await runScript(v.session.id);
    const closed = db.select().from(positions).where(eq(positions.accountId, v.session.accountId)).all().filter((p) => p.status === "closed");
    const journal = db.select().from(tradeJournal).where(eq(tradeJournal.sessionId, v.session.id)).all();
    expect(journal.length).toBe(closed.length);
    expect(journal.length).toBeGreaterThanOrEqual(3);
    expect(new Set(journal.map((j) => j.exitReason))).toEqual(new Set(["take_profit", "stop_loss", "manual"]));
    for (const p of closed) {
      const j = journal.find((r) => r.positionId === p.id)!;
      expect(j.netPnl).toBe(p.netPnl);
      expect(j.fees).toBeCloseTo(p.entryFee + p.exitFee, 8);
      expect(j.entryPrice).toBe(p.entryPrice);
      expect(j.exitPrice).toBe(p.exitPrice);
      if (p.initialRisk) expect(j.rMultiple).toBeCloseTo(p.netPnl! / p.initialRisk, 4);
      expect(j.mode).toBe("historical");
      expect(j.dataVersion).toMatch(/^v\d+ sha256:/);
    }
    const sumNet = journal.reduce((s, r) => s + r.netPnl, 0);
    const listed = listSessions(db).find((x) => x.session.id === v.session.id)!;
    expect(listed.trades).toBe(journal.length);
    expect(listed.netPnl).toBeCloseTo(sumNet, 6);
    expect(getSessionView(db, v.session.id).account.balance).toBeCloseTo(10_000 + sumNet, 6);
  });

  it("editing notes never changes execution data", async () => {
    const v = await newSession();
    await runScript(v.session.id);
    const j = listJournal(db, { sessionId: v.session.id }).rows[0];
    const beforeExec = db.select().from(executions).where(eq(executions.positionId, j.positionId)).all();
    const updated = updateJournalAnnotations(db, j.id, { notes: "Entered late", setupQuality: 4, ruleFollowed: false, tags: ["fomo"] });
    expect(updated!.notes).toBe("Entered late");
    expect(updated!.netPnl).toBe(j.netPnl);
    expect(updated!.entryPrice).toBe(j.entryPrice);
    const afterExec = db.select().from(executions).where(eq(executions.positionId, j.positionId)).all();
    expect(afterExec).toEqual(beforeExec);
    expect(getJournalEntry(db, j.id)!.executions).toHaveLength(2);
  });

  it("exports CSV with a header and one line per trade", async () => {
    const v = await newSession();
    await runScript(v.session.id);
    const csv = journalCsv(db, { sessionId: v.session.id });
    const lines = csv.split("\r\n");
    expect(lines[0]).toMatch(/^id,mode,market,symbol,strategy/);
    expect(lines.length - 1).toBe(listJournal(db, { sessionId: v.session.id }).total);
  });
});

describe("idempotency controls", () => {
  it("refuses to record the same execution twice and rolls back", async () => {
    const v = await newSession();
    const before = getSessionView(db, v.session.id).account.balance;
    sessionCommand(db, v.session.id, { kind: "place", clientOrderId: "x", side: "buy", type: "market", qty: 0.1 });
    const exec = listExecutions(db, v.session.accountId)[0];
    const afterFirst = getSessionView(db, v.session.id).account.balance;
    expect(() =>
      db.transaction((tx) =>
        persistEngineResult(
          tx,
          { accountId: v.session.accountId, sessionId: v.session.id, instrumentId: v.instrument.id, mode: "historical", dataSource: "t", dataVersion: "t" },
          { state: { balance: afterFirst - 999, orders: [], positions: [] }, orders: [], positions: [], events: [], executions: [{ ...exec, flags: exec.flags as never }] as never },
        ),
      ),
    ).toThrow(DuplicateExecutionError);
    expect(getSessionView(db, v.session.id).account.balance).toBe(afterFirst);
    expect(before).toBe(10_000);
  });
});

describe("data gaps", () => {
  it("reports missing bars and never fabricates them", async () => {
    provider.data["1h"] = H1.filter((_, i) => i !== 10 && i !== 11); // drop 10:00 and 11:00
    const v = await newSession();
    expect(v.session.gapCount).toBe(2);
    expect(v.warnings.join(" ")).toMatch(/2 missing bar/);
    const r = await step(v.session.id, 8); // 03:00..09:00, then 12:00
    expect(r.bars.map((b) => new Date(b.time).getUTCHours())).toEqual([3, 4, 5, 6, 7, 8, 9, 12]);
  });
});

describe("session recovery", () => {
  it("resumes exactly where it left off after the database is reopened", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradelab-")), "t.db");
    const first = openDb(file);
    db = first.db;
    const v = await newSession();
    sessionCommand(db, v.session.id, { kind: "place", clientOrderId: "r1", side: "buy", type: "market", qty: 0.1, sl: 63_000 });
    await step(v.session.id, 3);
    const snap = getSessionView(db, v.session.id);
    first.sqlite.close();

    db = openDb(file).db;
    const resumed = getSessionView(db, v.session.id);
    expect(resumed.session.cursorTime).toBe(snap.session.cursorTime);
    expect(resumed.session.revision).toBe(snap.session.revision);
    expect(resumed.openPositions.map((p) => p.id)).toEqual(snap.openPositions.map((p) => p.id));
    expect(resumed.account.balance).toBe(snap.account.balance);
    const next = await step(v.session.id, 1);
    expect(next.applied).toBe(true);
    expect((await verifyReplay(db, v.session.id)).ok).toBe(true);
  });
});

describe("CSV import", () => {
  it("imports real candles from CSV and replays them", async () => {
    const csv = ["time,open,high,low,close,volume", ...H1.map((b) => `${new Date(b.time).toISOString()},${b.open},${b.high},${b.low},${b.close},${b.volume}`)].join("\n");
    const imp = importCsv(db, { symbol: "BTCCSV", timeframe: "1h", text: csv, tickSize: 0.01, qtyStep: 0.00001 });
    expect(imp.inserted).toBe(48);
    expect(imp.gaps).toBe(0);
    const v = await createSession(db, { source: "csv", datasetId: imp.dataset.id, timeframe: "1h", from: FROM, to: TO, startingBalance: 1_000 });
    expect(v.instrument.sourceId).toBe("csv");
    const r = await step(v.session.id, 2);
    expect(r.bars).toHaveLength(2);
    expect(() => importCsv(db, { symbol: "BTCCSV", timeframe: "1h", text: csv, label: imp.dataset.label })).toThrow(/immutable/);
  });
});
