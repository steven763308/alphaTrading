# Execution model

One engine (`src/lib/engine/engine.ts`) runs both historical replay and live paper trading. It is pure and deterministic: no clock, no randomness, no I/O. Same starting state + same bars + same commands = same fills, every time. `tests/` proves it, and every session has a **Verify replay** button that re-runs the whole session from its command log.

## Prices

| Concept | Rule |
|---|---|
| Candle prices | Treated as **mid** prices (Binance klines are last-trade prices; mid is the closest standard assumption). |
| Bid / ask | `ask = mid × (1 + spread/2)`, `bid = mid × (1 − spread/2)`. Buys trade at the ask, sells at the bid. |
| Slippage | Applied adversely to **taker** fills only (market, stop entry, stop loss): `buy × (1 + slip)`, `sell × (1 − slip)`. |
| Rounding | Fill prices are rounded to the tick size **against the trader** (buys up, sells down). Quantities are rounded **down** to the step. |
| Fees | `price × qty × contractSize × feeBps`. Maker rate for limit entries and take profits; taker rate for everything else. |

## Order handling

| Order | Triggers when | Fills at |
|---|---|---|
| Market | immediately | last known price ± spread ± slippage (replay: close of the cursor bar; live: latest streamed price) |
| Buy limit | bar ask-low ≤ limit | the limit price, or the open if the bar opened below it (better) |
| Sell limit | bar bid-high ≥ limit | the limit price, or the open if the bar opened above it (better) |
| Buy stop | bar ask-high ≥ stop | the stop price + slippage, or the open + slippage if the bar gapped above it (worse) |
| Sell stop | bar bid-low ≤ stop | the stop price − slippage, or the open − slippage if it gapped below (worse) |

Placement is validated. A buy limit must be below the ask, a buy stop above it, and so on, and SL/TP must sit on the correct side of the entry. Rejected orders are still stored for audit.

## Look-ahead prevention

1. **Future masking.** The server only ever sends candles at or before the replay cursor (`/api/sessions/:id/candles`). Future candles never reach the browser.
2. **`activeFrom`.** A pending order may fill only on bars whose open time is ≥ the time it was placed. In replay, an order placed after bar *N* closed can first fill on bar *N+1*. In live mode, `activeFrom` is set strictly after the last price event received, so price action from before the order existed can never fill it.
3. **Entry gating.** A position cannot be stopped out by a bar that started before its entry.
4. **Moved orders/levels.** A dragged pending order gets a new `activeFrom`. A position's SL/TP can only be moved to the correct side of the current exit quote, so it can't trigger on price that has already happened.

## Intrabar ambiguity (conservative rules)

OHLC bars don't tell you the path inside the bar, so the engine never guesses in the trader's favour:

| Situation | Without lower-timeframe data | With 1m data (Binance, default on) |
|---|---|---|
| Existing position: SL **and** TP touched in one bar | **SL assumed first**; flagged `ambiguous_sl_tp` | bar replayed minute by minute; flagged `resolved_lower_tf` |
| Bar opens beyond SL | fills at the (worse) open, flagged `gap_open` | same |
| Bar opens beyond TP | fills at the (better) open, flagged `gap_open` | same |
| Pending entry fills mid-bar, then SL is within the bar | **SL assumed hit**, flagged `ambiguous_entry_bar` | resolved minute by minute |
| Pending entry fills mid-bar, then TP is within the bar | **TP never assumed** — position stays open | resolved minute by minute |

1m resolution is used only when **all** minutes of the bar exist. A partial minute series could hide the real path. Ambiguity inside a 1m bar falls back to the same conservative rules. Lower-timeframe resolution is fixed when a session is created, so replays stay deterministic.

## Live paper trading specifics

- The server holds one WebSocket to `data-stream.binance.vision` and subscribes to `<symbol>@kline_1m` for every symbol with exposure or an open chart.
- Consecutive kline updates (every ~2 s) become small **segments**. A segment's high/low comes from the kline's cumulative high/low only if it **extended** since the previous update. Otherwise only the span between the two closes is certain. This never invents an extreme the market didn't print in that window.
- A position opened inside a segment gets the conservative entry-bar rules for that segment.
- **Staleness:** no data for `staleAfterSeconds` (default 20 s) marks the feed stale and market execution is refused. No data for 60 s forces a reconnect. Disconnects reconnect with exponential backoff (1 s → 30 s).
- **Reconciliation:** after a disconnect, a gap in the stream, or a server restart, the period since the last processed time is replayed from REST 1m candles (up to `reconcileLookbackHours`). Fills produced this way are flagged `reconciled_gap`, the journal shows them as **approx**, and a `feed_reconciled` event is written to the audit log. If the REST data can't be fetched, the symbol stays **unreconciled**. Nothing is processed for it until it can be, and no prices are assumed.
- Cancelling is always allowed; anything that needs a price is refused while data is stale, disconnected, or reconciling.

**Local-first limitation:** paper orders are only monitored while the app is running. A stop that would have triggered while your PC was off is filled during reconciliation at the stop price (with slippage), using 1m candles. That approximates what would have happened and is clearly flagged; it is not a guarantee.

## Idempotency & audit

- Executions have deterministic primary keys (`pos_<orderId>:entry|exit`). Recording a fill twice is impossible: the transaction aborts and rolls back the balance change.
- Orders carry a client-generated `clientOrderId`, unique per account, so double-clicks and retries never create two orders.
- `advance` requests carry the session `revision`. A stale or duplicated request is a no-op, and concurrent ones conflict (HTTP 409) instead of double-stepping.
- `simulation_events` is append-only. It records every command (with its cursor position, used for replay verification), every engine event, feed reconciliations, gaps, and account resets.
- Journal edits touch only annotation columns (`notes`, `setup_quality`, `rule_followed`, `tags`, `annotations`). Execution facts can't be modified through the API.

## Multi-market rules

### Instruments and quantity

| Market | Quantity unit | Contract size | Tick | Default leverage* |
|---|---|---|---|---|
| Crypto spot | coins | 1 | exchange tick | 1 (fully funded) |
| Forex | lots | 100,000 base units | 0.00001 (0.001 for JPY quotes) | 1:30 |
| XAUUSD | lots | 100 oz | 0.01 | 1:20 |
| XAGUSD | lots | 5,000 oz | 0.001 | 1:10 |
| US stocks/ETFs | shares | 1 | 0.01 | 1 |

\*Leverage and financing values are typical retail assumptions, editable per session, and fixed once a session is created so replays stay deterministic.

**Tick value** = tick × contract size × quote→account rate. The ticket shows it per unit.

### Currency conversion

All money (fees, spread/slippage costs, initial risk, P&L, margin, financing) is in the **account currency**: USD for non-crypto sessions, USDT for crypto. USDT is treated as USD 1:1.

| Case | Example | Rule |
|---|---|---|
| Quote = account currency | EURUSD, XAUUSD, BTCUSDT | identity |
| Base = account currency | USDJPY | divide the quote-currency amount by the instrument's own price **at that fill** |
| Cross | EURGBP, EURJPY | multiply by the conversion pair's rate (GBPUSD close; 1/USDJPY) as of the bar close or live price |

Realised P&L converts at the **exit** fill; risk and entry costs convert at the **entry** fill. In backtests the conversion pair is downloaded automatically from the same provider and stored with the session. Live, the conversion pair is streamed too, and an order is refused if its price is unavailable.

### Costs

- **Percentage fees** (maker/taker bps) on notional.
- **Fixed commission** per quantity unit per side (e.g. $3.50 per FX lot), in account currency.
- **Spread:** when a bar carries an observed bid/ask spread (Dukascopy and OANDA store mid prices plus spread), that spread is used for that bar instead of the configured one. Live quote feeds use the quote's own spread.
- **Slippage** as before (taker fills only).

### Margin, leverage and stop-out

- Margin for a position = notional (account currency) ÷ leverage, reserved at entry.
- **At placement:** an order is rejected if its margin plus the estimated taker fee exceeds free margin. Free margin = balance + unrealized P&L (all positions) − used margin (all positions).
- **At fill:** a pending order is re-checked when it would fill, and rejected ("…at fill") if margin is no longer available.
- **Stop-out:** at each bar close, if equity ÷ used margin < the stop-out level (default 50%), every open position on that instrument is closed at the close price (taker). Those fills are flagged `stop_out` because the true intrabar moment is unknown.
- Sessions created before multi-market support have no leverage set and keep the original no-margin rules.

### Financing / swaps

At each daily rollover (17:00 New York, DST-aware) inside a bar, every position opened before the rollover is charged or credited notional × annual rate ÷ 365. The rollover on the configured triple day (Wednesday for FX/metals) counts 3 days to cover the weekend. The amount is added to the position's `financing`, applied to the balance immediately, included in net P&L, and logged as a `position_financed` event. It is bar-granular: a position closed earlier in the same bar is not charged.

### Sessions and holidays

| Calendar | Open |
|---|---|
| `24x7` | always (crypto) |
| `fx` | Sunday 17:00 → Friday 17:00 New York; closed Christmas Day and New Year's Day until 17:00 |
| `metals` | as `fx`, plus a daily 17:00–18:00 New York break |
| `us_equity` | 09:30–16:00 New York, Mon–Fri, excluding NYSE full-day holidays (New Year, MLK, Presidents, Good Friday, Memorial, Juneteenth from 2022, Independence, Labor, Thanksgiving, Christmas, with weekend-observance rules) |

- **Live:** market orders and manual closes are refused while the market is closed (pending orders are accepted), and no segment is processed off-session, so nothing fills on weekend or after-hours quotes. A quiet feed while every subscribed market is closed is not treated as stale.
- **Replay:** bars exist only when the market traded. A market order fills at the visible bar's close, which is the last traded price, equivalent to a market-on-close on a session's final bar.
