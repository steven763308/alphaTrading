import { decimalsOf } from "@/lib/engine/math";

export function fmtPrice(v: number | null | undefined, tick = 0.01): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = Math.min(decimalsOf(tick), 8);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtQty(v: number | null | undefined, step = 0.0001): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: Math.min(decimalsOf(step), 8) });
}

export function fmtMoney(v: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = opts.decimals ?? 2;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (v < 0) return `−${s}`;
  return opts.sign && v > 0 ? `+${s}` : s;
}

export function fmtPct(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(decimals)}%`;
}

export function fmtR(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`;
}

export function pnlClass(v: number | null | undefined): string {
  if (v == null || v === 0) return "text-muted";
  return v > 0 ? "text-up" : "text-down";
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string, withSeconds: boolean) {
  const key = `${timeZone}|${withSeconds}`;
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: withSeconds ? "2-digit" : undefined,
      hourCycle: "h23",
    });
    dtfCache.set(key, f);
  }
  return f;
}

/** UTC epoch ms → "YYYY-MM-DD HH:mm" in the display time zone. */
export function fmtTime(ms: number | null | undefined, timeZone = "UTC", withSeconds = false): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const parts = Object.fromEntries(dtf(timeZone, withSeconds).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${withSeconds ? `:${parts.second}` : ""}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const FLAG_LABELS: Record<string, string> = {
  gap_open: "Gap fill at open",
  ambiguous_sl_tp: "SL & TP in same candle — SL assumed",
  ambiguous_entry_bar: "Exit on entry candle — worst case assumed",
  resolved_lower_tf: "Resolved with 1m data",
  reconciled_gap: "Filled during data-gap reconciliation (approximate)",
  stale_data: "Stale data",
  stop_out: "Margin stop-out at bar close (exact moment unknown)",
};

/** Flags that indicate genuine uncertainty (resolved_lower_tf is informational). */
export const UNCERTAIN_FLAGS = new Set(["ambiguous_sl_tp", "ambiguous_entry_bar", "reconciled_gap", "stale_data", "stop_out"]);
