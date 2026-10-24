# ByteX TradeLab

A local-first, **multi-market** trading simulator, backtester and automatic trade journal. You can replay real historical data bar by bar, or paper-trade live prices, placing orders straight from the chart. Every fill is journaled and analysed automatically. It works on desktop, iPad, iPhone and Android/Fold through the browser.

> **Education and paper trading only.** TradeLab never places real orders. It uses only read-only market-data endpoints and never trading APIs.

## Markets and data sources

| Market | Historical | Live paper | Source | Status |
|---|---|---|---|---|
| Crypto (BTCUSDT, ETHUSDT, SOLUSDT, any Binance spot pair) | ✅ | ✅ | Binance public API, no key | **verified** |
| Forex (EURUSD, GBPUSD, USDJPY, crosses) | ✅ | needs OANDA | Dukascopy datafeed, no key | historical **verified** |
| Metals (XAUUSD, XAGUSD) | ✅ | needs OANDA | Dukascopy datafeed, no key | historical **verified** |
| Forex & metals (alternative) | ✅ | ✅ | OANDA v20, free practice token | **unverified** (needs your token) |
| US stocks / ETFs (AAPL, NVDA, TSLA, SPY…) | ✅ | ✅ | Alpaca, free keys (IEX feed) | **unverified** (needs your keys) |
| Anything else (indices, futures, commodities, other brokers' exports) | ✅ | — | Universal CSV import | **verified** |

- **"Verified"** means the adapter was run end to end against the real service while building this release. **"Unverified"** means it was implemented from the provider's documentation and covered by parser tests, but needs your credentials before it can be exercised. Use **Settings → Data providers → Test** to check it.
- If no configured source supports an instrument (or mode), the UI says **unavailable** and gives the reason. Delayed or substitute data is **never** shown instead. For example, live XAUUSD without OANDA is unavailable; it is not replaced with a gold token.

## Features

- **Historical replay.** Real candles only; the server never sends candles after the replay cursor. Step, play/pause at 1–60 bars/s, resume any time, and use **Verify** to re-run the whole session and prove every fill reproduces exactly.
- **Live paper trading.** Live candles or quotes with connection, staleness, market-session and last-data indicators. Missed periods are reconciled from 1m candles, and those fills are flagged.
- **One execution engine** for all markets and both modes:
  - market/limit/stop orders, SL/TP, cancel, close
  - contract sizes (FX lot = 100,000; XAU lot = 100 oz; XAG lot = 5,000 oz; shares; coins)
  - tick size and tick value, lot steps
  - **currency conversion** into the account currency (USDJPY, crosses such as EURGBP via GBPUSD)
  - commissions, spread (the **real observed bid/ask spread** when the data has it), slippage
  - **margin and leverage**, with checks at placement and fill plus a stop-out
  - **financing/swap** at the daily rollover (Wednesday triple)
  - **trading sessions and NYSE holidays**: no market orders while closed, no fills off-session

  See [docs/EXECUTION_MODEL.md](docs/EXECUTION_MODEL.md).
- **Chart trading.** With a mouse: Alt+click sets the entry, Shift+click the SL, Ctrl+click the TP. On touch screens, tap the **Entry / SL / TP** buttons, then tap the chart. Drag price lines with mouse or finger.
- **Automatic journal.** Every closed trade is recorded with market, symbol, strategy, timeframe, side, times, prices, size, SL/TP, gross/net P&L, fees, spread/slippage, financing, initial risk, R-multiple, holding time, reasons, mode, data source/version and uncertainty flags. Notes, rating, rule-followed, tags and chart annotations are editable; execution data is not. CSV export included.
- **Analytics across markets.** Win rate, P&L, profit factor, expectancy, average R, drawdown and equity curve, broken down by **market**, strategy, timeframe, session, weekday, holding time, side, symbol and historical vs live. Every group shows its sample size and a "low n" flag, and warnings call out misleading statistics.

## Install on Windows

**Requirements:** [Node.js](https://nodejs.org/) 20.9 or newer (22 LTS recommended; tested on 25.8). Nothing else is needed: SQLite is embedded.

```powershell
cd bytex-tradelab
npm install
copy .env.example .env.local   # optional; crypto + Dukascopy history work without any keys
npm run dev                    # http://localhost:3000
```

The database (`data/tradelab.db`) is created and migrated automatically, including upgrades of existing databases.

Faster production mode, also recommended for phones and tablets:

```powershell
npm run build
npm run start:lan              # serves on your home network at port 3000
```

## Using it on iPad / iPhone / Android / Fold

1. Run `npm run build` then `npm run start:lan` on your Windows PC. Allow Node.js on **private** networks when Windows Firewall asks.
2. Set `TRADELAB_ACCESS_KEY=<something long>` in `.env.local` so other people on your Wi-Fi can't open it.
3. On the device, open the address shown in **Settings → Use on iPad / iPhone** (for example `http://192.168.1.20:3000`) and enter the key once.
4. In Safari, tap **Share → Add to Home Screen** to get a full-screen app icon (Chrome on Android: **Install app**).

Layouts:
- **Phones and Fold cover screens:** chart on top; Order and Trades tabs below; bottom tab bar.
- **iPad portrait and Fold unfolded:** larger chart with the bottom panel.
- **iPad landscape and desktop:** chart, order ticket sidebar and trades table.

Historical backtesting runs entirely on your PC, so the device only needs to reach it. To use it **away from home**, put your PC and phone on a private VPN such as Tailscale (free for personal use). TradeLab deliberately never exposes itself to the public internet.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload (also reachable on the LAN) |
| `npm run build` / `npm start` | Production build / server |
| `npm run start:lan` | Production server bound to your network, for phones and tablets |
| `npm test` | Automated test suite (offline, uses real-data fixtures) |
| `npm run typecheck` / `npm run lint` | TypeScript / ESLint |
| `npm run db:generate` | Generate a migration after editing `src/lib/server/db/schema.ts` |
| `npm run fixtures` | Re-download the Binance test fixtures |

### Environment variables

See [.env.example](.env.example). All are optional.

| Variable | Purpose |
|---|---|
| `TRADELAB_ACCESS_KEY` | Access key for phone/tablet use (off when empty) |
| `DATABASE_PATH` | SQLite file (default `./data/tradelab.db`) |
| `BINANCE_REST_URL` / `BINANCE_WS_URL` | Binance market-data endpoints (defaults: `*.binance.vision` mirrors) |
| `DUKASCOPY_URL` | Dukascopy datafeed base URL |
| `OANDA_API_TOKEN` / `OANDA_ACCOUNT_ID` / `OANDA_ENV` | OANDA practice data (live FX/metals) |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` / `ALPACA_FEED` | Alpaca stock data (`iex` on the free plan) |
| `TRADELAB_DISABLE_LIVE` | `1` = don't start the live feed at boot |

## Using it

1. **Simulator → Historical → New session.** Pick the market and instrument (availability is shown per instrument), timeframe, dates, balance, risk %, leverage, strategy and costs. Market data is downloaded in the background with a progress bar and cached; later sessions only fetch what's missing.
2. **Trade** from the ticket or the chart. The ticket shows quantity in lots, shares or coins, plus risk and reward in account currency, required margin, value per tick and estimated fees.
3. **Step / Play.** Fills, SL/TP exits, financing and P&L update as bars are revealed.
4. **Live Paper.** Choose a market. If a live source exists you get the stream, otherwise an explicit "unavailable" notice. Trading pauses automatically when data is stale or the market is closed (pending orders are still accepted).
5. **Journal / Analytics / Settings** to review trades, compare markets, strategies and timeframes, and configure costs, providers, strategies, CSV import and device access.

### CSV import

Use a header row with `time, open, high, low, close[, volume]` (`timestamp`/`date`/`open_time` are also accepted), or headerless Binance kline dumps. Times can be ISO (UTC if no zone is given) or epoch seconds, milliseconds or microseconds. Set the tick size, quantity step and contract size at import. Invalid rows are rejected, not repaired; gaps are reported, never filled. Each import is an immutable dataset.

## Testing

```powershell
npm test
```

The suite runs 98 tests. They cover sizing for every market (coins, lots, shares; JPY and cross conversion), P&L in account currency, commissions, the observed spread, margin rejection (at placement and at fill), stop-out, financing (including the Wednesday triple), FX/metals/NYSE sessions and holidays, and rollovers. They also cover real Dukascopy XAUUSD decoding and an **XAUUSD backtest on real data**, resumable rate-limited downloads, incremental coverage, OANDA/Alpaca parsing and "unavailable" behaviour, quote-driven live FX trading with weekend handling, everything from the first release (look-ahead, same-candle SL/TP, determinism, idempotency, journal consistency, gaps, recovery, reconnection and reconciliation), and analytics. Expected values: [docs/TESTING.md](docs/TESTING.md).

## Operating costs

| Item | Cost |
|---|---|
| Binance, Dukascopy data | **RM0** (public, no key) |
| OANDA practice / Alpaca free (IEX) | **RM0** (free accounts) |
| Charts, database, hosting | **RM0** (open-source libraries, SQLite file, your PC) |
| Remote access (optional) | **RM0** with a free personal VPN such as Tailscale |
| Disk | ~60 MB per symbol per year of 1m data; 1h data is tiny |

No paid service, cloud worker or always-on server is used. **Automatic live-order execution while your PC is off would need an always-on service** (a small VPS or home server). That is deliberately not set up, and it would be the first thing that costs money.

## Limitations

- **Paper only.** Queue position, partial fills, order-book depth and market impact are not simulated.
- **Price basis differs by source.** Binance/Alpaca candles are trade prices with a configured spread. Dukascopy/OANDA candles are mid prices with the observed spread. Mid high/low from Dukascopy are averages of the bid and ask extremes (an approximation).
- **Intrabar order is unknowable from OHLC.** Same-candle SL/TP uses 1m data where practical (Binance); otherwise the worst case is assumed and the fill is flagged.
- **Margin stop-out is checked at bar close**, not at the exact intrabar moment. The fill is flagged `stop_out`.
- **Financing is bar-granular.** A position closed in the same bar as the rollover isn't charged. Rates are assumptions, not a broker's swap table. No dividends or corporate actions; Alpaca bars are unadjusted.
- **Sessions:** FX Sunday 17:00 to Friday 17:00 New York; metals have a daily 17:00–18:00 break; NYSE 09:30–16:00 with full-day holidays (early closes are not modelled; no pre/post-market trading).
- **Dukascopy is slow and rate-limited** (often 15–30 s per file, HTTP 429, dropped connections). Downloads are serialised, retried with backoff and saved per file, so a failure resumes where it stopped. Minute data needs 2 files per day, so prefer 1h+ for long ranges. Check Dukascopy's terms for your use.
- **Alpaca's free plan is IEX-only.** Prices and volumes can differ from the consolidated tape.
- **USDT is treated as USD 1:1.** Cross-currency P&L uses the conversion pair's close (historical) or live price, and is refused when that price is unavailable.
- **Live monitoring needs the app running.** After downtime, missed periods (default 72 h) are replayed from 1m candles and flagged "approx".
- **Single user, single process.** The LAN mode is meant for your own devices; use the access key.

## Project docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): structure, providers, data model, extension points
- [docs/EXECUTION_MODEL.md](docs/EXECUTION_MODEL.md): every fill, cost, margin, financing and session rule
- [docs/TESTING.md](docs/TESTING.md): fixtures and expected results
