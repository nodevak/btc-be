/**
 * BTC/USDT Paper Trading Bot
 * Strategy: Williams %R(14) signal + Ichimoku Chikou filter
 * SL: 1.5% | TP: 3.0% | Risk: $10/trade
 *
 * Set these environment variables in Railway:
 *   TELEGRAM_TOKEN   — from @BotFather
 *   TELEGRAM_CHAT_ID — your chat ID from @userinfobot
 */

import fetch from 'node-fetch';
import fs from 'fs';
import express from 'express';
import cors from 'cors';

// ─── CONFIG ─────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INITIAL_BALANCE  = 100;
const RISK_USD         = 10;
const SL_PCT           = 0.015;
const TP_PCT           = 0.030;
const WR_PERIOD        = 14;
const CHIKOU_SHIFT     = 26;
const POLL_INTERVAL_MS = 30 * 1000;   // check every 30 seconds
const STATE_FILE       = './state.json';

// ─── STATE ──────────────────────────────────────────────────
let state = loadState();
let pendingSignal = null;  // { direction } — queued for next candle open

function defaultState() {
  return {
    balance: INITIAL_BALANCE,
    trades: [],
    openTrade: null,
    lastCandleOpen: null,
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Could not load state, starting fresh:', e.message);
  }
  return defaultState();
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Could not save state:', e.message);
  }
}

// ─── BINANCE API ────────────────────────────────────────────
async function fetchCandles() {
  const url = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=500';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API returned ${res.status}`);
  const data = await res.json();
  return data.map(k => ({
    time:   Math.floor(parseInt(k[0]) / 1000),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
  }));
}

// ─── INDICATORS ─────────────────────────────────────────────
function calcWilliamsR(candles, period = WR_PERIOD) {
  return candles.map((c, i) => {
    if (i < period - 1) return null;
    const slice = candles.slice(i - period + 1, i + 1);
    const hh = Math.max(...slice.map(x => x.high));
    const ll = Math.min(...slice.map(x => x.low));
    if (hh === ll) return -50;
    return ((hh - c.close) / (hh - ll)) * -100;
  });
}

function checkChikouFilter(candles, i, direction) {
  if (i < CHIKOU_SHIFT) return false;
  const chikouValue = candles[i].close;
  const pastPrice   = candles[i - CHIKOU_SHIFT].close;
  if (direction === 'SHORT') return chikouValue < pastPrice;
  if (direction === 'LONG')  return chikouValue > pastPrice;
  return false;
}

function detectSignal(wr, i) {
  if (wr[i] === null || wr[i - 1] === null) return 0;
  if (wr[i - 1] > -20 && wr[i] <= -20) return -1; // SHORT
  if (wr[i - 1] < -80 && wr[i] >= -80) return +1; // LONG
  return 0;
}

// ─── TRADE LOGIC ────────────────────────────────────────────
function enterTrade(direction, entryPrice, candle) {
  const slDist  = entryPrice * SL_PCT;
  const sizeBTC = RISK_USD / slDist;
  const sl = direction === 'LONG'
    ? entryPrice * (1 - SL_PCT)
    : entryPrice * (1 + SL_PCT);
  const tp = direction === 'LONG'
    ? entryPrice * (1 + TP_PCT)
    : entryPrice * (1 - TP_PCT);

  const trade = {
    id:          state.trades.length + 1,
    direction,
    entryTime:   new Date(candle.time * 1000).toISOString(),
    entryPrice,
    exitTime:    null,
    exitPrice:   null,
    sl, tp, sizeBTC,
    riskUSD:     RISK_USD,
    pnl:         null,
    result:      null,
    exitVia:     null,
    balanceAfter: null,
  };

  state.openTrade = trade;

  const emoji = direction === 'LONG' ? '🟢' : '🔴';
  sendTelegram(
    `${emoji} <b>TRADE OPENED — ${direction}</b>\n` +
    `Entry: <code>$${f2(entryPrice)}</code>\n` +
    `SL:    <code>$${f2(sl)}</code> (-1.5%)\n` +
    `TP:    <code>$${f2(tp)}</code> (+3.0%)\n` +
    `Size:  <code>${sizeBTC.toFixed(6)} BTC</code>\n` +
    `Risk:  <code>$${RISK_USD}</code>\n` +
    `Balance: <code>$${f2(state.balance)}</code>`
  );
}

function closeTrade(trade, exitPrice, exitTime, exitVia) {
  const dir = trade.direction === 'LONG' ? 1 : -1;
  const pnl = (exitPrice - trade.entryPrice) * trade.sizeBTC * dir;

  trade.exitPrice   = exitPrice;
  trade.exitTime    = exitTime;
  trade.exitVia     = exitVia;
  trade.pnl         = pnl;
  trade.result      = pnl > 0.01 ? 'win' : pnl < -0.01 ? 'loss' : 'be';

  state.balance    += pnl;
  trade.balanceAfter = state.balance;
  state.trades.push(trade);
  state.openTrade  = null;

  const emoji  = trade.result === 'win' ? '✅' : trade.result === 'loss' ? '❌' : '⚪';
  const pnlStr = pnl >= 0 ? `+$${f2(pnl)}` : `-$${f2(Math.abs(pnl))}`;
  const viaStr = exitVia === 'TP' ? '🎯 Take Profit' : exitVia === 'SL' ? '🛑 Stop Loss' : '⏱ Timeout (reversal)';

  sendTelegram(
    `${emoji} <b>TRADE CLOSED — ${trade.direction} #${trade.id}</b>\n` +
    `Exit via: ${viaStr}\n` +
    `Entry: <code>$${f2(trade.entryPrice)}</code>\n` +
    `Exit:  <code>$${f2(exitPrice)}</code>\n` +
    `P&L:   <code>${pnlStr}</code>\n` +
    `Balance: <code>$${f2(state.balance)}</code>\n` +
    `Total Return: <code>${(((state.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100).toFixed(2)}%</code>`
  );
}

function checkSlTp(candle) {
  if (!state.openTrade) return;
  const t       = state.openTrade;
  const exitTime = new Date(candle.time * 1000).toISOString();

  if (t.direction === 'LONG') {
    if (candle.low  <= t.sl) { closeTrade(t, t.sl, exitTime, 'SL'); return; }
    if (candle.high >= t.tp) { closeTrade(t, t.tp, exitTime, 'TP'); return; }
  } else {
    if (candle.high >= t.sl) { closeTrade(t, t.sl, exitTime, 'SL'); return; }
    if (candle.low  <= t.tp) { closeTrade(t, t.tp, exitTime, 'TP'); return; }
  }
}

// ─── MAIN PROCESSING ────────────────────────────────────────
function processCandles(candles, wr) {
  // Only process fully closed candles (all except the last building candle)
  const closedCount = candles.length - 1;
  if (closedCount < 2) return;

  const lastClosed = candles[closedCount - 1];

  // Skip if already processed
  if (state.lastCandleOpen === lastClosed.time) return;

  // Find start index (first unprocessed closed candle)
  let startIdx = closedCount - 1;
  if (state.lastCandleOpen !== null) {
    for (let i = 0; i < closedCount; i++) {
      if (candles[i].time === state.lastCandleOpen) {
        startIdx = i + 1;
        break;
      }
    }
  }

  for (let i = startIdx; i < closedCount; i++) {
    // 1. Execute pending entry (queued from previous candle's signal)
    if (pendingSignal !== null) {
      enterTrade(pendingSignal.direction, candles[i].open, candles[i]);
      pendingSignal = null;
    }

    // 2. Check SL/TP for open trade on this candle
    if (state.openTrade) {
      checkSlTp(candles[i]);
    }

    // 3. Detect signal on this closed candle
    if (i >= 1) {
      const signal = detectSignal(wr, i);
      if (signal !== 0) {
        const dir = signal === 1 ? 'LONG' : 'SHORT';
        const filterPass = checkChikouFilter(candles, i, dir);

        if (filterPass) {
          if (state.openTrade) {
            if (state.openTrade.direction !== dir) {
              // Timeout: close current, queue new
              closeTrade(state.openTrade, candles[i].close, new Date(candles[i].time * 1000).toISOString(), 'TIMEOUT');
              pendingSignal = { direction: dir };
            }
            // Same direction: ignore
          } else {
            pendingSignal = { direction: dir };

            // Notify signal (will enter next candle)
            const emoji = dir === 'LONG' ? '🟢' : '🔴';
            sendTelegram(
              `${emoji} <b>SIGNAL FIRED — ${dir}</b>\n` +
              `WR: <code>${wr[i].toFixed(1)}</code>\n` +
              `Chikou Filter: PASS ✅\n` +
              `BTC Price: <code>$${f2(candles[i].close)}</code>\n` +
              `Entry will fill at next candle open…`
            );
          }
        } else {
          // Signal fired but filter failed
          const emoji = dir === 'LONG' ? '🟡' : '🟡';
          sendTelegram(
            `⚠️ <b>SIGNAL SKIPPED — ${dir}</b>\n` +
            `WR: <code>${wr[i].toFixed(1)}</code>\n` +
            `Chikou Filter: FAIL ❌\n` +
            `(No trade taken)`
          );
        }
      }
    }
  }

  state.lastCandleOpen = lastClosed.time;
  saveState();
}

// ─── TELEGRAM ───────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM DISABLED]', text.replace(/<[^>]+>/g, ''));
    return;
  }
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
        }),
      }
    );
  } catch (e) {
    console.error('Telegram send error:', e.message);
  }
}

// ─── STATUS REPORT ──────────────────────────────────────────
async function sendDailyStatus(candles, wr) {
  const lastWr   = wr[wr.length - 2];
  const price    = candles[candles.length - 1].close;
  const ret      = (((state.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100).toFixed(2);
  const trades   = state.trades;
  const wins     = trades.filter(t => t.result === 'win').length;
  const wr_rate  = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '—';
  const openInfo = state.openTrade
    ? `${state.openTrade.direction} @ $${f2(state.openTrade.entryPrice)}`
    : 'None';

  await sendTelegram(
    `📊 <b>Daily Status Report</b>\n` +
    `BTC: <code>$${f2(price)}</code>\n` +
    `Balance: <code>$${f2(state.balance)}</code> (<code>${ret >= 0 ? '+' : ''}${ret}%</code>)\n` +
    `Open Trade: <code>${openInfo}</code>\n` +
    `Total Trades: <code>${trades.length}</code>\n` +
    `Win Rate: <code>${wr_rate}%</code>\n` +
    `Williams %R: <code>${lastWr !== null ? lastWr.toFixed(1) : '—'}</code>`
  );
}

// ─── HELPERS ────────────────────────────────────────────────
function f2(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── MAIN LOOP ──────────────────────────────────────────────
let lastDailyReport = null;

async function tick() {
  try {
    const candles = await fetchCandles();
    const wr      = calcWilliamsR(candles);
    processCandles(candles, wr);

    // Daily status at 00:00 UTC
    const now  = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (dayKey !== lastDailyReport && now.getUTCHours() === 0 && now.getUTCMinutes() < 1) {
      lastDailyReport = dayKey;
      await sendDailyStatus(candles, wr);
    }

    const price   = candles[candles.length - 1].close;
    const lastWr  = wr[wr.length - 2];
    console.log(
      `[${new Date().toISOString()}]`,
      `BTC $${f2(price)}`,
      `WR: ${lastWr !== null ? lastWr.toFixed(1) : '—'}`,
      `Balance: $${f2(state.balance)}`,
      state.openTrade ? `Open: ${state.openTrade.direction}` : 'No trade'
    );
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Error:`, e.message);
  }
}

// ─── HTTP API SERVER ────────────────────────────────────────
// Serves live state to the Vercel frontend

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); // allow requests from your Vercel domain

// GET /state — full state (trades, balance, open trade)
app.get('/state', (req, res) => {
  res.json({
    balance:     state.balance,
    trades:      state.trades,
    openTrade:   state.openTrade,
    initialBalance: INITIAL_BALANCE,
    updatedAt:   new Date().toISOString(),
  });
});

// GET /health — uptime check
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});

// ─── START ──────────────────────────────────────────────────
console.log('🤖 BTC Paper Trader Bot starting…');
console.log(`   Telegram: ${TELEGRAM_TOKEN ? 'configured ✅' : 'NOT SET ⚠️'}`);
console.log(`   State file: ${STATE_FILE}`);

sendTelegram('🤖 <b>BTC Paper Trader Bot started</b>\nMonitoring BTC/USDT 15m…\nStrategy: Williams %R + Ichimoku Chikou');

tick(); // run immediately
setInterval(tick, POLL_INTERVAL_MS);
