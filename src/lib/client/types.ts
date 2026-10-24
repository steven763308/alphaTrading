// Type-only imports: erased at build time, so no server code reaches the browser.
import type { getSessionView, listSessions } from "@/lib/server/services/backtest";
import type { getLiveState } from "@/lib/server/services/live";
import type { OrderRow, PositionRow, JournalRow } from "@/lib/server/repo/trading";
import type { AppSettings } from "@/lib/server/settings-defaults";
import type { InstrumentRow } from "@/lib/server/repo/market";
import type { strategies } from "@/lib/server/db/schema";

export type SessionView = ReturnType<typeof getSessionView>;
export type SessionListItem = ReturnType<typeof listSessions>[number];
export type LiveState = ReturnType<typeof getLiveState>;
export type { OrderRow, PositionRow, JournalRow, AppSettings, InstrumentRow };
export type Strategy = typeof strategies.$inferSelect;

export interface TicketDraft {
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  entry: number | null;
  sl: number | null;
  tp: number | null;
  sizing: "risk" | "qty";
  riskPercent: number;
  qty: number | null;
  strategyId: number | null;
  note: string;
}
