import os from "node:os";
import { json, route } from "@/lib/server/http";
import { listProviders } from "@/lib/server/services/market-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** LAN addresses for opening TradeLab on phones/tablets, plus provider capabilities. */
export const GET = route((req: Request) => {
  const port = new URL(req.url).port || (process.env.PORT ?? "3000");
  const lan: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) lan.push(`http://${a.address}:${port}`);
    }
  }
  return json({
    lanUrls: lan,
    accessKeyEnabled: Boolean(process.env.TRADELAB_ACCESS_KEY),
    devMode: process.env.NODE_ENV !== "production",
    providers: listProviders(),
  });
});
