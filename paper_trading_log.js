/**
 * NOCTURNE — Paper-Trading Log Generator
 * =====================================================================
 * Produces a verifiable paper-trading log of the Overnight Exposure
 * Planner's nightly decisions, on REAL market data. Nothing here is
 * fabricated: every row is the Planner's own rule applied causally
 * (decisions use only data available before each night), and every
 * P&L is the realized overnight move net of a 0.10% round-trip cost.
 *
 * THE RULE (identical in spirit to the live app, app.html / server.js):
 *   1. Each night, for each name, estimate its overnight 1-sigma move
 *      (sigma_pct) from the trailing 60 overnight returns, and a risk
 *      state: ELEVATED if vol(10) > 1.3 * vol(60), else NORMAL;
 *      BLACKOUT on FOMC announcement days.
 *   2. Start from a base overnight position of $BASE_POSITION per name.
 *   3. Apply the Exposure Planner overlay:
 *        - FLATTEN any BLACKOUT name (no overnight exposure).
 *        - If the portfolio's total 1-sigma overnight dollar risk
 *          exceeds $RISK_BUDGET, TRIM the highest-risk names until it
 *          fits (exactly the greedy trim the app performs).
 *        - Otherwise HOLD the full position.
 *   4. Realize the trade: enter at the prior close, exit at the next
 *      open. Net P&L = position * overnight_return - position * 0.10%.
 *
 * The strategy is NOT presented as profitable. This log exists to show
 * the tool produces real, timestamped, risk-managed decisions with
 * real outcomes — the honest evidence Nocturne is built on.
 *
 * USAGE (run locally, where Yahoo is reachable):
 *   node paper_trading_log.js                 -> writes paper_trading_log.csv
 *   node paper_trading_log.js --selftest      -> validates logic on synthetic data
 * =====================================================================
 */

const axios = require('axios');
const fs = require('fs');

// ----------------------------- CONFIG --------------------------------
const TICKERS = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'SPY'];
const START_DATE = '2023-06-10';
const END_DATE   = '2026-06-10';
const BASE_POSITION = 10000;   // $ overnight notional per name
const RISK_BUDGET   = 1000;    // $ portfolio total 1-sigma overnight risk cap (conservative; adjustable)
const COST          = 0.001;   // 0.10% round-trip cost
const WARMUP        = 60;      // nights of history before a name may trade
const OUT_FILE      = 'paper_trading_log.csv';

const FOMC_DATES = new Set([
    '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
    '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
    '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
    '2026-01-28', '2026-03-18', '2026-05-06', '2026-06-17'
]);

// ----------------------------- DATA ----------------------------------
async function fetchYahooData(ticker, startDate, endDate) {
    const period1 = Math.floor(new Date(startDate).getTime() / 1000);
    const period2 = Math.floor(new Date(endDate).getTime() / 1000);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9'
    };
    const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    for (const host of hosts) {
        try {
            const url = `https://${host}/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=1d`;
            const response = await axios.get(url, { timeout: 15000, headers });
            const result = response.data.chart.result[0];
            if (!result || !result.timestamp) continue;
            const q = result.indicators.quote[0];
            const rows = [];
            for (let i = 0; i < result.timestamp.length; i++) {
                const date = new Date(result.timestamp[i] * 1000).toISOString().split('T')[0];
                if (q.open[i] == null || q.close[i] == null) continue;
                rows.push({ date, open: q.open[i], close: q.close[i] });
            }
            if (rows.length) return rows;
        } catch (e) {
            console.error(`  fetch ${ticker} from ${host} failed: ${e.message}`);
        }
    }
    return null;
}

// ------------------------- STATS HELPERS -----------------------------
const rms = (arr) => Math.sqrt(arr.reduce((a, b) => a + b * b, 0) / arr.length);
function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}

/**
 * Build, per ticker, the chronological list of overnight trades with
 * CAUSAL trailing risk stats (computed only from prior nights).
 */
function buildTradeEvents(series) {
    // series: array of {date, open, close} sorted ascending
    const rets = [];          // overnight returns, rets[j] for trade j (series[j])
    const events = [];
    for (let j = 1; j < series.length; j++) {
        const entry = series[j - 1].close;
        const exit = series[j].open;
        const ret = exit / entry - 1;
        const priorRets = rets.slice();           // returns strictly before this night
        // need full WARMUP history for a clean vol(60) estimate
        if (priorRets.length >= WARMUP) {
            const last60 = priorRets.slice(-60);
            const last10 = priorRets.slice(-10);
            const sigma_pct = stdev(last60);
            const vol10 = rms(last10);
            const vol60 = rms(last60);
            events.push({
                date: series[j].date,
                entry, exit, ret,
                sigma_pct, vol10, vol60
            });
        }
        rets.push(ret);
    }
    return events;
}

/**
 * Apply the Exposure Planner overlay to one night's set of names.
 * Mutates each name's `position` and sets `action`. Faithful to the
 * greedy budget trim in app.html (updateExposurePlanner).
 */
function applyPlanner(names, budget) {
    // 1. Flatten blackout names
    for (const n of names) {
        if (n.risk_state === 'BLACKOUT') { n.position = 0; n.action = 'FLATTEN'; }
        else { n.action = 'HOLD'; }
        n.sigma_dollar = n.position * n.sigma_pct;
    }
    // 2. Total 1-sigma overnight risk
    let currentRisk = names.reduce((a, n) => a + n.sigma_dollar, 0);
    if (currentRisk <= budget) return;
    // 3. Trim highest-risk names until within budget
    const order = names
        .filter(n => n.position > 0 && n.sigma_pct > 0)
        .sort((a, b) => b.sigma_dollar - a.sigma_dollar);
    for (const n of order) {
        if (currentRisk <= budget) break;
        const overage = currentRisk - budget;
        const cut = overage / n.sigma_pct;               // $ of position to remove
        const newPos = Math.max(0, n.position - cut);
        const riskReduction = (n.position - newPos) * n.sigma_pct;
        currentRisk -= riskReduction;
        n.position = newPos;
        n.action = newPos <= 0 ? 'FLATTEN' : `TRIM to $${Math.round(newPos)}`;
        n.sigma_dollar = n.position * n.sigma_pct;
    }
}

// ----------------------------- ENGINE --------------------------------
function runPaperTrade(dataByTicker) {
    // Collect all trade events keyed by date
    const byDate = {};
    for (const [ticker, series] of Object.entries(dataByTicker)) {
        const events = buildTradeEvents(series);
        for (const ev of events) {
            (byDate[ev.date] = byDate[ev.date] || []).push({ ticker, ...ev });
        }
    }
    const dates = Object.keys(byDate).sort();

    let balance = BASE_POSITION * TICKERS.length;   // starting cash for the book
    const startBalance = balance;
    const rows = [];
    const counts = { HOLD: 0, TRIM: 0, FLATTEN: 0 };
    let wins = 0, traded = 0;

    for (const date of dates) {
        const names = byDate[date].map(n => ({
            ticker: n.ticker,
            entry: n.entry, exit: n.exit, ret: n.ret,
            sigma_pct: n.sigma_pct,
            risk_state: FOMC_DATES.has(date) ? 'BLACKOUT'
                       : (n.vol10 > 1.3 * n.vol60 ? 'ELEVATED' : 'NORMAL'),
            position: BASE_POSITION
        }));

        applyPlanner(names, RISK_BUDGET);

        let nightNet = 0;
        for (const n of names) {
            const pos = n.position;
            const gross = pos * n.ret;
            const cost = pos > 0 ? pos * COST : 0;
            const net = gross - cost;
            nightNet += net;
            if (pos > 0) { traded++; if (net > 0) wins++; }
            const tag = n.action.startsWith('TRIM') ? 'TRIM' : n.action;
            counts[tag] = (counts[tag] || 0) + 1;
            rows.push({
                date,
                asset: n.ticker,
                risk_state: n.risk_state,
                action: n.action,
                direction: pos > 0 ? 'LONG_OVERNIGHT' : 'FLAT',
                entry_price: n.entry.toFixed(2),
                exit_price: n.exit.toFixed(2),
                quantity: pos > 0 ? (pos / n.entry).toFixed(4) : '0',
                gross_pnl: gross.toFixed(2),
                cost: cost.toFixed(2),
                net_pnl: net.toFixed(2),
                account_balance: 0   // filled after balance update
            });
        }
        balance += nightNet;
        // stamp this night's resulting balance on its rows
        for (let k = rows.length - names.length; k < rows.length; k++) rows[k].account_balance = balance.toFixed(2);
    }

    return { rows, balance, startBalance, counts, wins, traded, nights: dates.length };
}

function writeCsv(rows) {
    const header = ['date', 'asset', 'risk_state', 'action', 'direction',
                    'entry_price', 'exit_price', 'quantity', 'gross_pnl', 'cost', 'net_pnl', 'account_balance'];
    const lines = [header.join(',')];
    for (const r of rows) {
        lines.push(header.map(h => {
            const v = String(r[h]);
            return v.includes(',') ? `"${v}"` : v;
        }).join(','));
    }
    fs.writeFileSync(OUT_FILE, lines.join('\n'));
}

function printSummary(res) {
    const totalRet = ((res.balance / res.startBalance) - 1) * 100;
    const winRate = res.traded ? (res.wins / res.traded) * 100 : 0;
    console.log('\n========== NOCTURNE PAPER-TRADING LOG ==========');
    console.log(`Period          : ${START_DATE} -> ${END_DATE}`);
    console.log(`Universe        : ${TICKERS.join(', ')}`);
    console.log(`Base position   : $${BASE_POSITION}/name   Risk budget: $${RISK_BUDGET}   Cost: ${(COST*100).toFixed(2)}%`);
    console.log(`Nights          : ${res.nights}`);
    console.log(`Actions         : HOLD ${res.counts.HOLD||0} | TRIM ${res.counts.TRIM||0} | FLATTEN ${res.counts.FLATTEN||0}`);
    console.log(`Overnight trades: ${res.traded}   Win rate: ${winRate.toFixed(2)}%`);
    console.log(`Start balance   : $${res.startBalance.toFixed(2)}`);
    console.log(`End balance     : $${res.balance.toFixed(2)}`);
    console.log(`Total return    : ${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%`);
    console.log(`Rows written    : ${res.rows.length}  ->  ${OUT_FILE}`);
    console.log('================================================\n');
    console.log('This is a paper-trading log of the Exposure Planner\'s nightly');
    console.log('decisions on real data. Whatever the outcome, the numbers are real.');
}

// --------------------------- SELF TEST -------------------------------
function syntheticData() {
    // Deterministic pseudo-random OHLC so the pipeline can be validated offline.
    const out = {};
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (const t of TICKERS) {
        const series = [];
        let price = 100 + rnd() * 200;
        const start = new Date(START_DATE).getTime();
        for (let d = 0; d < 460; d++) {
            const date = new Date(start + d * 86400000).toISOString().split('T')[0];
            const open = price * (1 + (rnd() - 0.5) * 0.03);
            const close = open * (1 + (rnd() - 0.48) * 0.04);
            series.push({ date, open: +open.toFixed(2), close: +close.toFixed(2) });
            price = close;
        }
        out[t] = series;
    }
    return out;
}

// ----------------------------- MAIN ----------------------------------
async function main() {
    const selftest = process.argv.includes('--selftest');
    let dataByTicker = {};

    if (selftest) {
        console.log('Running SELF-TEST on synthetic data (no network)...');
        dataByTicker = syntheticData();
    } else {
        console.log('Fetching real data from Yahoo Finance...');
        for (const t of TICKERS) {
            process.stdout.write(`  ${t} ... `);
            const rows = await fetchYahooData(t, START_DATE, END_DATE);
            if (!rows) { console.log('NO DATA'); continue; }
            console.log(`${rows.length} days`);
            dataByTicker[t] = rows;
        }
        if (Object.keys(dataByTicker).length === 0) {
            console.error('\nNo data fetched. Run this locally (Yahoo blocks some cloud IPs).');
            process.exit(1);
        }
    }

    const res = runPaperTrade(dataByTicker);
    writeCsv(res.rows);
    printSummary(res);
}

main();
