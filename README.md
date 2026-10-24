# ByteX TradeLab

A local-first trading **simulator, backtester and automatic trade journal**. Replay real Binance history bar by bar, or paper-trade live prices, placing orders straight from the chart. Every fill is journaled and analysed automatically.

> **Education and paper trading only.** TradeLab never connects to an exchange account, never uses API keys and never sends orders anywhere. Market data comes from Binance's public endpoints.

## Features

- **Historical replay:** real Binance klines (or your own CSV). The server hides every candle after the replay cursor. Step, play/pause at 1–60 bars/s, resume any time, and use **Verify replay** to prove the session reproduces exactly.
- **Live paper trading:** Binance WebSocket candles with a connection/staleness indicator and the last data timestamp. Missed periods are reconciled from 1m candles and those fills are flagged.
- **One execution engine** for both modes: market, limit and stop orders, SL/TP, cancel, manual close, risk-based sizing, maker/taker fees, spread, slippage, gap handling, and conservative same-candle SL/TP rules with optional 1m resolution. See [docs/EXECUTION_MODEL.md](docs/EXECUTION_MODEL.md).
- **Chart trading:** Alt+click sets the entry, Shift+click the SL, Ctrl+click the TP. Drag the entry/SL/TP lines of drafts, pending orders and open positions.
- **Automatic journal:** every closed trade records entry/exit, size, SL/TP (initial and final), gross/net P&L, fees, spread/slippage, initial risk, R-multiple, holding time, reasons, strategy, mode, data source and version, plus uncertainty flags. Notes, setup quality, rule-followed, tags and chart annotations are editable. Execution data is not. CSV export included.
- **Analytics:** win rate, net P&L, profit factor, expectancy, average win/loss, average R, max drawdown, equity curve, streaks, and breakdowns by strategy, timeframe, trading session, weekday, holding time, side, symbol and historical vs live. Every group shows its sample size and is flagged "low n" below 30 trades. Warnings call out misleading results such as a high win rate with negative expectancy, a small sample, or a strategy profitable only before costs.

## Install on Windows

**Requirements:** [Node.js](https://nodejs.org/) 20.9 or newer (22 LTS recommended; tested on 25.8). Nothing else is needed: SQLite is embedded, and `better-sqlite3` ships prebuilt Windows binaries.

```powershell
git clone <this repo> bytex-tradelab   # or copy the folder
cd bytex-tradelab
npm install
copy .env.example .env.local           # optional; defaults work out of the box
npm run dev                            # http://localhost:3000
```

The database (`data/tradelab.db`) is created and migrated automatically on first start.

For a faster, production-mode local run:

```powershell
npm run build
npm start
```

If `npm install` fails building `better-sqlite3` (only on unusual Node versions without a prebuilt binary), install the "Desktop development with C++" workload of Visual Studio Build Tools, or switch to Node 22 LTS.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build` / `npm start` | Production build / server |
| `npm test` | Run the automated test suite (offline, uses fixtures) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:generate` | Generate a new migration after editing `src/lib/server/db/schema.ts` |
| `npm run fixtures` | Re-download the real Binance test fixtures (output is identical; history doesn't change) |

### Environment variables

See [.env.example](.env.example). All are optional:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_PATH` | `./data/tradelab.db` | SQLite file |
| `BINANCE_REST_URL` | `https://data-api.binance.vision` | Public market-data REST mirror |
| `BINANCE_WS_URL` | `wss://data-stream.binance.vision` | Public market-data WebSocket mirror |
| `TRADELAB_DISABLE_LIVE` | `0` | `1` = don't start the live feed at server boot |

The `binance.vision` mirrors serve market data only and work in regions where `api.binance.com` is blocked (it was unreachable from the development machine). You can point the variables at `https://api.binance.com` / `wss://stream.binance.com:9443` if you prefer.

## Using it

1. **Simulator → Historical → New session.** Pick a symbol (any Binance spot pair), timeframe, UTC date range, starting balance, risk %, strategy tag and costs. Data is downloaded once and cached.
2. **Trade.** Use the ticket on the right, or set levels on the chart. With "By risk %" sizing, the quantity is computed from your stop distance, including estimated fees and slippage.
3. **Step** with → or Space, **play/pause** with P, and adjust speed. Fills, SL/TP exits and P&L update as bars are revealed.
4. **Live Paper.** Type a symbol and timeframe. Orders execute against streamed prices; trading pauses automatically when data is stale or disconnected.
5. **Trade Journal.** Review each trade, add notes, a rating, the rule-followed flag, tags and chart annotations, or export CSV.
6. **Analytics.** Filter by symbol, strategy, timeframe, mode, side and dates.
7. **Settings.** Set the time zone, default risk and costs, strategies, CSV import, and the live account reset.

### CSV import format

A header row with `time, open, high, low, close[, volume]` in any order (`timestamp`/`date`/`open_time` also accepted), or headerless Binance kline dumps. Times can be ISO strings (UTC assumed when no zone is given) or epoch seconds, milliseconds or microseconds. Invalid rows (non-positive prices, high/low inconsistent with open/close) are rejected, not repaired. Gaps are counted and reported, never filled.

## Testing

```powershell
npm test
```

The suite covers 55 scenarios: position sizing, long/short P&L, fees, spread and slippage, SL/TP and pending fills, gaps, look-ahead prevention, same-candle SL/TP (conservative vs real 1m resolution), deterministic replay, duplicate and concurrent requests, idempotent executions, journal consistency, data gaps, session recovery after reopening the DB, CSV import, live streaming, staleness, disconnect and reconciliation, failed reconciliation, and analytics. Fixtures are **real** BTCUSDT candles (2024-03-04/05, 1h and 1m) in `tests/fixtures`. [docs/TESTING.md](docs/TESTING.md) lists the expected values and how they were derived.

## Operating costs

| Item | Cost |
|---|---|
| Market data (Binance public REST + WebSocket) | **RM0** (no key, no subscription) |
| Charting (TradingView Lightweight Charts, Apache-2.0) | **RM0** |
| Database (SQLite file on your disk) | **RM0** |
| Hosting | **RM0** — runs on your PC |
| Disk | ~60 MB per year of 1m data per symbol (~525k rows); higher timeframes are negligible |
| CPU/RAM | One Node process, typically 150–300 MB RAM; idle CPU near zero, live feed < 1% |

No paid services, cloud workers or extra infrastructure are used. Deploying to a server would be the first thing that costs money and is deliberately not set up.

## Limitations (read these)

- **Paper only.** Fills are modelled, not real. Queue position, partial fills, order-book depth and market impact are not simulated. Liquidity is assumed sufficient for your size.
- **Candles are treated as mid prices.** Binance klines are trade prices. Spread and slippage are fixed parameters you set, not observed values.
- **Intrabar order is unknowable from OHLC.** Same-candle SL/TP is resolved with 1m data when available, otherwise the worst case is assumed. Within a 1m bar the worst case is always assumed. Such fills are flagged.
- **Live monitoring needs the app running.** If your PC sleeps or the app is closed, stops and targets are not watched in real time. On restart the missed period (up to 72 h by default) is replayed from 1m candles and those fills are flagged "approx". Beyond the lookback, the gap is logged as unreconciled.
- **Live segments are ~2 s windows.** Pending orders can't fill on price action from before they were placed, so a very brief wick right after placing an order may be ignored (the conservative choice).
- **No margin, leverage, funding or liquidation model.** Shorts are simulated like CFDs. The account can go negative if you over-size.
- **No partial closes or scaling in.** Each filled entry order is one position with one exit.
- **Crypto spot only out of the box.** CSV import supports any market, but session times are plain UTC (no exchange calendars or holidays).
- **Single user, single process.** Running two servers against the same database file is not supported.

## Project docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): structure, data model, extension points
- [docs/EXECUTION_MODEL.md](docs/EXECUTION_MODEL.md): every fill rule and uncertainty flag
- [docs/TESTING.md](docs/TESTING.md): fixtures and expected results
