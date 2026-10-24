import { getDb } from "@/lib/server/db/client";
import { query } from "@/lib/server/http";
import { getLiveFeed, liveInstrument } from "@/lib/server/services/live";
import { isTimeframe } from "@/lib/market/timeframes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-Sent Events: live candles, prices, feed status and account change signals. */
export async function GET(req: Request) {
  const q = query(req);
  const symbol = (q.get("symbol") || "BTCUSDT").toUpperCase();
  const timeframe = q.get("tf") || "1m";
  if (!/^[A-Z0-9]{2,20}$/.test(symbol) || !isTimeframe(timeframe)) {
    return Response.json({ error: "Invalid symbol or timeframe" }, { status: 400 });
  }
  let instrumentId: string;
  try {
    instrumentId = (await liveInstrument(getDb(), symbol, q.get("provider") || undefined)).id;
  } catch (e) {
    // Unavailable: say so explicitly instead of streaming anything else.
    return Response.json({ error: e instanceof Error ? e.message : String(e), unavailable: true }, { status: 409 });
  }
  const feed = getLiveFeed();
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const unwatch = feed.watch(instrumentId, timeframe, send);
      const heartbeat = setInterval(() => send({ type: "heartbeat", time: Date.now() }), 15_000);
      cleanup = () => {
        clearInterval(heartbeat);
        unwatch();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
