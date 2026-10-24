# Tests and expected results

Run with `npm test` (Vitest, fully offline).

## Fixtures

Real Binance spot data downloaded by `scripts/fetch-fixtures.ts`:

| File | Content |
|---|---|
| `btcusdt-1h-2024-03-04.json` | 48 BTCUSDT 1h candles, 2024-03-04 00:00 → 2024-03-05 23:00 UTC |
| `btcusdt-1m-2024-03-04.json` | 2,880 BTCUSDT 1m candles over the same window |
| `btcusdt-info.json` | Contract spec: tick 0.01, qty step 0.00001, min 0.00001 |

Hourly bars referenced below (O / H / L / C):

| # | Time | Open | High | Low | Close |
|---|---|---|---|---|---|
| 0 | 03-04 00:00 | 63113.97 | 64268.24 | 62300.00 | 63459.30 |
| 2 | 02:00 | 63512.42 | 63881.66 | 63100.00 | 63687.43 |
| 3 | 03:00 | 63687.42 | 63754.45 | 63355.00 | 63458.72 |
| 4 | 04:00 | 63458.71 | 63775.00 | 63366.31 | 63634.36 |
| 5 | 05:00 | 63634.36 | 63706.00 | 63210.00 | 63358.00 |
| 7 | 07:00 | 63689.16 | 64300.00 | 63480.64 | 64066.62 |
| 8 | 08:00 | 64066.62 | 65500.00 | 64000.11 | 65241.08 |

Unless stated, engine tests use **zero costs** so expected numbers are exact.

## Engine (`tests/engine.*.test.ts`)

| Scenario | Expected |
|---|---|
| Sizing: equity 10,000, 1% risk, entry 100, stop 95, no costs | qty **20**, loss at stop **100** |
| Sizing with costs (taker 10, slip 5, spread 2 bps) | per-unit risk 5 + 195×0.0016 = **5.312**, qty **18.825** (rounded down) |
| Long market after bar 0 close (63459.30), SL 63000, TP 64000, qty 0.1 | TP fills on bar **7** at 64000; gross = net = **+54.07**; initial risk **45.93**; balance 10,054.07 |
| Short market after bar 0, SL 63900, TP 63200, qty 0.1 | TP on bar 2 (low 63100); P&L **+25.93** |
| Market buy @100 with taker 10 bps, spread 2, slip 5, tick 0.01; manual close @110 | entry **100.07** (ask 100.01 → +5 bp → round up), fee 0.10007; exit **109.93**, fee 0.10993; gross 9.86, net **9.65**, spread+slippage **0.14** |
| Buy limit 95 on bar L 94 | fills **95**, maker fee 0.095, no slippage |
| Long TP 101, candle high 101.005, 2 bp spread | **not filled** (bid ≈ 100.995) |
| Buy limit 63400 placed after bar 2 | fills on bar 3 at **63400** |
| Buy stop 64000 placed after bar 6 | fills on bar 7 at **64000**, taker |
| Buy stop 105, next bar opens 108 | fills at **108**, flag `gap_open` |
| Look-ahead: buy limit 63400 placed after bar 3 closed | bar 3 (low 63355) does **not** fill it; bar 4 (low 63366.31) does |
| Look-ahead: long entered after bar 5; re-processing bar 5 (low 63210) with SL 63300 | **no exit** |
| Long after bar 4 (63634.36), SL 63250 | stop loss on bar 5 at **63250**, P&L (63250 − 63634.36) × 0.1 |
| Long SL 95, next bar opens 90 | exit at **90** (worse open), `gap_open` |
| **Same candle:** short after bar 7 (64066.62), SL 65400, TP 64010; bar 8 touches both | no 1m data: **stop loss** at 65400, P&L **−133.338**, `ambiguous_sl_tp` |
| Same, with real 1m bars for 08:00 | 08:00 minute low 64008.55 ≤ TP, high 64093.15 < SL → **take profit** at 64010, P&L **+5.662**, `resolved_lower_tf` |
| Limit entry fills mid-bar and TP is in the same bar | TP **not** assumed; position stays open |
| Limit entry fills mid-bar and SL is in the same bar | SL assumed, `ambiguous_entry_bar` |
| Live segment [1000, 3000] containing the entry at 1500 | TP never assumed; SL exit stamped at the entry time; a segment entirely before the entry is ignored |

## Backtest service (`tests/backtest.service.test.ts`)

In-memory SQLite plus a fake provider serving the fixtures. Session: 1h, from 03-04 03:00 to 03-05 23:00, warm-up from 00:00.

| Scenario | Expected |
|---|---|
| Session start | cursor = **02:00**; only 3 candles visible; `before` in the future still never returns candles past the cursor |
| Advance 5 | reveals exactly 03:00–07:00 |
| Duplicate advance (same revision) | second call `applied: false`, cursor unchanged |
| Two concurrent advances (same revision) | exactly **one** applies |
| Same `clientOrderId` twice | second is `duplicate: true`; one position |
| Short SL 65400 / TP 64010 on bar 8 via the service | 1m enabled → **take_profit** + `resolved_lower_tf`; disabled → **stop_loss** + `ambiguous_sl_tp` |
| Scripted session (limit, unprotected market, short with SL/TP, manual close, cancel), with costs | **Verify replay**: no missing/extra executions, balances equal, checksum matches |
| The same script in two sessions | identical fills (side, qty, price, fee, time, reason, flags) and balance |
| Journal consistency | one row per closed position; net/fees/prices equal the position; R = net / initial risk; exit reasons include take_profit, stop_loss and manual; balance = start + Σ net |
| Editing notes/rating/rules/tags | execution rows byte-for-byte unchanged; P&L unchanged |
| Re-recording an existing execution | `DuplicateExecutionError`; balance rolled back |
| Data gaps (bars 10:00 and 11:00 removed) | `gapCount` **2** with a warning; stepping goes 09:00 → **12:00** (no synthetic bars) |
| Session recovery (file DB closed and reopened) | same cursor, revision, positions and balance; stepping continues; replay still verifies |
| CSV import of the fixture | 48 candles, 0 gaps; session replays it; re-import with the same label is refused (datasets are immutable) |

## Live feed (`tests/live.feed.test.ts`)

Fake WebSocket and REST provider, fixed clock at 2024-03-04 08:00 UTC, zero costs.

| Scenario | Expected |
|---|---|
| Market buy at 100, SL 99; update with new low 98.9 | stop loss at **99**; journal mode `live`, source `binance-ws:kline_1m`, no flags |
| Kline high already 101.5 before entry; later update with unchanged high | TP 101 **not** filled; filled only after a new high (101.6) |
| No data for 25 s | status `stale`; market orders refused ("No price is assumed…") |
| Disconnected | cancelling still works; new orders refused |
| Disconnect, market falls through SL at 08:05, reconnect | REST 1m replay closes the position at **95**, exit time **08:05**, flag `reconciled_gap`, `feed_reconciled` event logged, warning notice; not tradable until a fresh streamed price arrives |
| Reconnect while REST is down | symbol stays unreconciled; a stream update through the stop is **not** applied |
| Stream jumps from 08:00 to 08:03 | missed minutes fetched from REST; SL fill flagged `reconciled_gap` |

## Analytics and CSV (`tests/analytics-csv.test.ts`)

Trades +200, −100, +150, −100, −100, +300 (start 10,000): win rate **50%**, net **350**, PF **2.17**, avg win **216.67**, avg loss **100**, expectancy **58.33**, avg R **0.58**, max losing streak **2**, max DD **200** (1.95%). Warnings fire for n < 30, for high win rate with negative expectancy, and for "profitable only before costs". The CSV parser handles ISO/epoch/µs times, dedupes rows, counts gaps, and rejects inconsistent OHLC rows.

## Multi-market (`tests/multimarket.*.test.ts`, `tests/providers.test.ts`, `tests/live.quotes.test.ts`)

Additional real fixtures: `tests/fixtures/dukascopy/XAUUSD_2024_01_{BID,ASK}_candles_hour_1.bi5`. These are the original Dukascopy files for **February 2024** (Dukascopy months are zero-based).

| Scenario | Expected |
|---|---|
| XAUUSD sizing: $10,000 × 1%, entry 2040, stop 2030, 100 oz lots | $1,000 per lot → **0.10 lots** |
| EURUSD sizing: 20-pip stop | $200/lot → **0.50 lots**; with $3.50/side commission $207/lot → **0.48** |
| USDJPY sizing: 1-yen stop at 149 | ¥100,000 ÷ 149 = $671.14/lot → **0.14 lots** |
| AAPL sizing: $3 stop | **33 shares** |
| XAUUSD 0.10 lot 2040 → 2050 | **+$100**; margin = 2040 × 0.1 × 100 / 20 = **$1,020** |
| EURUSD 1 lot +10 pips, $3.50/side | gross **$100**, net **$93** |
| USDJPY 1 lot 150 → 151 | ¥100,000 ÷ 151 = **$662.25**; fills record fxRate 1/150 and 1/151 |
| EURGBP 1 lot +10 pips, GBPUSD 1.27 | £100 × 1.27 = **$127** |
| Margin: $1,000 balance, 1 lot XAU @ 2000 | rejected: "needs 10000.00, free 1000.00" |
| Margin with other exposure (used $800, unrealized −$100) | 0.01 lot fits exactly; 0.02 rejected |
| Pending 0.05 lot XAU limit at 1990 after another 0.05 lot filled | free margin at fill $450 < $497.50 → **rejected "at fill"** |
| Stop-out at 50%: 0.09 lot XAU from 2000, $1,000 balance | close 1940 → 51% (survives); close 1938 → 49.1% → **stop_out at 1938** |
| Observed spread 0.40 on bar low 2000 | buy limit 2000.10 **not** filled; 2000.20 filled |
| Financing −6%/yr on 1 lot XAU @ 2000, Wednesday rollover | 3 days: 200,000 × −6% ÷ 365 × 3 = **−$98.63**; Tuesday = 1 day; position opened after the rollover isn't charged |
| Sessions | FX closed Fri 17:00 → Sun 17:00 NY (EST and EDT); metals break 17:00–18:00; NYSE 09:30–16:00; 2024 holidays incl. Good Friday 03-29 and Juneteenth; 2022-06-20 observed; 2021-12-31 not a holiday |
| Rollovers in one week | 5, multipliers [1,1,3,1,1], Monday 22:00 UTC (EST), 21:00 UTC in summer |
| Dukascopy decode | 696 hourly records per side; first ASK O/C/L/H 2040.155/2040.992/2039.395/2042.865; BID open 2039.855 |
| Dukascopy merge | **481** trading hours (weekends and the daily break dropped); first MID open **2040.005**, close 2040.8185, spread **0.3235** |
| Provider 4h fetch via fixture server | January requested (404 = no data); 4h-aligned bars starting 2024-02-01 |
| **XAUUSD backtest (acceptance)** on real data | metals spec (100 oz lots, 1:20, metals calendar), USD account, MID basis; 0.10 lot buy at the ask; gross = Δprice × 0.1 × 100; net = gross − fees + financing; replay verified |
| Second session over the same range | **zero** new Dukascopy requests (cache + coverage) |
| Rate-limited (429) ASK file | first attempt fails with "parts were saved"; retry succeeds without re-requesting January |
| Coverage | covered empty ranges are skipped; adjacent ranges merge |
| Availability | live XAUUSD unavailable (mentions OANDA), historical → dukascopy; AAPL needs Alpaca; BTCUSDT live → binance |
| Conversion routing | XAUUSD identity; BTCUSDT identity (USDT≈USD); USDJPY inverse; EURGBP via GBPUSD; EURJPY via 1/USDJPY |
| OANDA parsing | MBA candles → MID + close spread; incomplete dropped; PRICE lines parsed, heartbeats ignored; unconfigured = unavailable |
| Alpaca parsing | bars, quotes, bar events, auth errors; IEX disclosure; unconfigured = unavailable |
| Live FX via quotes (Monday) | fill above mid (configured costs), margin = notional/30; SL on quotes; journal `forex`, `oanda-stream:quotes`, fees $7 |
| Live FX on Saturday | market order **rejected (market closed)**; limit accepted; a weekend quote through the limit does **not** fill |
