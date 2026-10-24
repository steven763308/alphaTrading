/**
 * Optional access key for using TradeLab from phones/tablets on your network.
 * Disabled unless TRADELAB_ACCESS_KEY is set. When set, every request needs the key
 * once (via ?key=… or the sign-in form); a cookie then remembers it on that device.
 * There is deliberately no "localhost bypass": Host headers can be spoofed on a LAN.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "tl_key";

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function loginPage(error: boolean) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ByteX TradeLab</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e13;color:#d8dde5;font:15px system-ui,sans-serif;padding:16px}
form{width:100%;max-width:320px;background:#0f131a;border:1px solid #1f2632;border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 4px}p{color:#8a94a3;margin:0 0 16px;font-size:13px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #2b3442;background:#0b0e13;color:#d8dde5;font-size:16px}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:#3987e5;color:#fff;font-size:16px;font-weight:600}
.e{color:#ef5350;margin-top:10px;font-size:13px}</style></head><body>
<form method="get"><h1>ByteX TradeLab</h1><p>Enter the access key set in TRADELAB_ACCESS_KEY.</p>
<input name="key" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Unlock</button>${error ? '<div class="e">Incorrect key.</div>' : ""}</form></body></html>`;
  return new NextResponse(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function proxy(req: NextRequest) {
  const key = process.env.TRADELAB_ACCESS_KEY;
  if (!key) return NextResponse.next();

  const cookie = req.cookies.get(COOKIE)?.value;
  if (cookie && same(cookie, key)) return NextResponse.next();

  const given = req.nextUrl.searchParams.get("key");
  if (given != null) {
    if (same(given, key)) {
      const url = req.nextUrl.clone();
      url.searchParams.delete("key");
      const res = NextResponse.redirect(url);
      res.cookies.set(COOKIE, key, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365, path: "/" });
      return res;
    }
    return loginPage(true);
  }
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Access key required" }, { status: 401 });
  return loginPage(false);
}

export const config = {
  // Static assets, icons and the manifest stay public so the sign-in page renders.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest).*)"],
};
