# Methodology

This document describes exactly what Nocturne computes, so the results are fully reproducible and auditable. Everything below is implemented in [`server.js`](server.js) and runs over real market data with no synthetic inputs.

## Data

- **Underlying equities:** daily OHLCV from the Yahoo Finance public chart API (`query1.finance.yahoo.com/v8/finance/chart`), fetched live per request. Rows with null open/close are dropped.
- **Tokenized assets:** hourly candles for the tokenized symbols (`AAPLONUSDT`, `NVDAONUSDT`, `TSLAONUSDT`, `MSFTONUSDT`, `AMZNONUSDT`, `METAONUSDT`, `SPYONUSDT`) from Bitget's public market API, used for the closed-market analysis. Bitget's endpoint caps history at ~1000 hourly candles (~41 days), so this layer is computed over a recent real snapshot.
- **Default universe:** AAPL, NVDA, TSLA, MSFT, AMZN, META, SPY.

## 1. Gap Engine (`POST /api/backtest`)

For each trading day `t` (skipping the first two days for lookback, and **excluding FOMC announcement days** to remove scheduled-event noise):

**Signal.**
- Overnight gap: `gap = (open_t − close_{t−1}) / close_{t−1}`
- Volume confirmation: `vol_ratio = volume_{t−1} / mean(volume over prior 20 days)`
- **CONTINUATION** (trade *with* the gap) if `|gap| ≥ continuation_gap` **and** `vol_ratio ≥ vol_ratio_high` → `direction = sign(gap)`
- **FADE** (trade *against* the gap) if `|gap| ≥ gap_threshold` **and** `vol_ratio < vol_ratio_low` → `direction = −sign(gap)`
- Otherwise: no trade.

**Execution & exit.**
- Entry at the day's open.
- ATR(14) computed via true range; protective stop at `entry ∓ ATR × atr_multiplier`.
- Exit at the stop if breached intraday, otherwise at the day's close.
- **Costs:** 0.10% per trade, applied to every position.
- Trade return: `direction × (exit − entry) / entry − costs`.

**Portfolio.**
- At most `max_positions` trades per day; selected trades equal-weighted at `0.5 / k` (50% gross capital deployed, split across `k` names).
- Equity compounds from a 100,000 base. SPY is scaled to the same base as a benchmark.

**Evaluation.**
- Strict **70/30 in-sample / out-of-sample split** by chronological index.
- Metrics per segment: total return, CAGR (annualized at 252 trading days), annualized volatility, Sharpe, Sortino, max drawdown, win rate, trade count.
- **Why it's honest:** a strategy with a real edge should hold up out-of-sample. Nocturne's typically does *worse* OOS — the explicit signature of an overfit/no-edge result, shown rather than hidden.

## 2. Overnight Hold Analysis (`POST /api/overnight`)

A **parameter-free** decomposition (no thresholds, no optimization) of where return actually accrues:

- Overnight: `ret_overnight = open_t / close_{t−1} − 1`
- Intraday: `ret_intraday = (close_t − open_t) / open_t`
- Buy & hold: `ret_bnh = close_t / close_{t−1} − 1`

Computed per ticker and as an **equal-weight portfolio** (simple average across names per date), then compounded into cumulative curves. A net series subtracts a **0.10% nightly round-trip cost** from each overnight return to test the overnight premium as a *tradeable* strategy.

Metrics are reported four ways — **IS gross, IS net, OOS gross, OOS net** — on the same 70/30 split. The on-screen "Parameter-Free Finding" text is generated directly from the computed net total-return and Sharpe values, so the prose and the table are guaranteed to agree.

## 3. Closed-Market Exposure · Tokenized (Bitget)

Computed from real Bitget hourly candles. "Closed" = hours the underlying US market is shut (Mon–Fri 16:00–09:30 ET plus weekends; exchange holidays ignored). For each token:

- **% of total price movement** occurring during closed hours (baseline: closed hours are ~80.7% of the week).
- **Per-hour realized volatility**, closed vs open.
- **Largest single closed-hours move** and its timestamp.

Key result: movement-in-closed (~70.9% on average) is *below* the ~80.7% time baseline, and per-hour volatility is *lower* when closed. Overnight exposure is therefore driven by **elapsed time**, not elevated volatility.

## 4. Overnight Risk Monitor

Per name, from the overnight return series (`open_t / close_{t−1} − 1`):

- **1σ overnight move** (sample standard deviation) and worst historical overnight move.
- **Risk state:** ELEVATED if 10-day realized vol > 1.3 × 60-day realized vol, else NORMAL.
- **Return concentration:** cumulative overnight return / cumulative buy-&-hold return (how much of total return is earned overnight).

## 5. Overnight Exposure Planner

Given user holdings and a risk budget, each position's 1σ overnight dollar risk is summed (a deliberately conservative simple sum that **ignores diversification/correlation**), and a per-name action (HOLD / TRIM / FLATTEN) is prioritized by blackout state → concentration → 1σ risk.

## Assumptions & caveats

- 0.10% per-trade / per-night cost is a single round-trip estimate; real costs vary.
- The Planner's total-risk figure ignores correlation by design (conservative).
- Bitget history is limited to the API's ~1000-candle (~41-day) window.
- All figures are historical and descriptive. **Not financial advice.**
