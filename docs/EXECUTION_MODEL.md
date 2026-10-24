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
