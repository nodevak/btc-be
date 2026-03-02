/**
 * BTC/USDT Paper Trading Bot
 * Strategy: Williams %R(14) signal + Ichimoku Chikou filter
 * SL: 1.5% | TP: 3.0% | Risk: $10/trade
 *
 * Commands:
 *   /stats    — balance, return, win rate, drawdown, indicators
 *   /position — current open trade details + live P&L
 *   /history  — last 20 closed trades
 *   /help     — list all commands
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
const POLL_INTERVAL_MS = 30 * 1000;
const STATE_FILE       = './state.json';

// FIX 1: Reduced from 500 to 50 — we only need 29 candles minimum.
// Using 50 gives comfortable headroom for catch-up after downtime.
const CANDLE_LIMIT     = 50;

// ─── STATE ──────────────────────────────────────────────────
let state         = loadState();
let lastCandles   = [];
let lastWR        = null;

function defaultState() {
  return {
    balance:        INITIAL_BALANCE,
    trades:         [],
    openTrade:      null,
    lastCandleOpen: null,
    // FIX 2: pendingSignal now lives in state so it survives restarts
    pendingSignal:  null,
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Merge with defaults so old state files without pendingSignal still work
      return { ...defaultState(), ...saved };
    }
  } catch (e) { console.error('Could not load state:', e.message); }
  return defaultState();
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error('Could not save state:', e.message); }
}

// ─── BINANCE API ────────────────────────────────────────────
async function fetchCandles() {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=${CANDLE_LIMIT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Binance API returned ${res.status}`);
  const data = await res.json();
  return data.map(k => ({
    time:  Math.floor(parseInt(k[0]) / 1000),
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
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
  const sl = direction === 'LONG' ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
  const tp = direction === 'LONG' ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);

  state.openTrade = {
    id:           state.trades.length + 1,
    direction,
    entryTime:    new Date(candle.time * 1000).toISOString(),
    entryPrice,
    exitTime:     null,
    exitPrice:    null,
    sl, tp, sizeBTC,
    riskUSD:      RISK_USD,
    pnl:          null,
    result:       null,
    exitVia:      null,
    balanceAfter: null,
  };

  const emoji = direction === 'LONG' ? '🟢' : '🔴';
  sendTelegram(
    `${emoji} <b>TRADE OPENED — ${direction}</b>\n` +
    `Entry:   <code>$${f2(entryPrice)}</code>\n` +
    `SL:      <code>$${f2(sl)}</code>  <i>(-1.5%)</i>\n` +
    `TP:      <code>$${f2(tp)}</code>  <i>(+3.0%)</i>\n` +
    `Size:    <code>${sizeBTC.toFixed(6)} BTC</code>\n` +
    `Risk:    <code>$${RISK_USD}</code>\n` +
    `Balance: <code>$${f2(state.balance)}</code>`
  );
}

function closeTrade(trade, exitPrice, exitTime, exitVia) {
  const dir  = trade.direction === 'LONG' ? 1 : -1;
  const pnl  = (exitPrice - trade.entryPrice) * trade.sizeBTC * dir;

  trade.exitPrice    = exitPrice;
  trade.exitTime     = exitTime;
  trade.exitVia      = exitVia;
  trade.pnl          = pnl;
  trade.result       = pnl > 0.01 ? 'win' : pnl < -0.01 ? 'loss' : 'be';
  state.balance     += pnl;
  trade.balanceAfter = state.balance;
  state.trades.push(trade);
  state.openTrade    = null;

  const emoji  = trade.result === 'win' ? '✅' : trade.result === 'loss' ? '❌' : '⚪';
  const pnlStr = pnl >= 0 ? `+$${f2(pnl)}` : `-$${f2(Math.abs(pnl))}`;
  const viaStr = exitVia === 'TP'
    ? '🎯 Take Profit'
    : exitVia === 'SL'
    ? '🛑 Stop Loss'
    : '⏱ Timeout (reversal)';
  const ret = (((state.balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100);

  sendTelegram(
    `${emoji} <b>TRADE CLOSED — ${trade.direction} #${trade.id}</b>\n` +
    `Exit via:  ${viaStr}\n` +
    `Entry:     <code>$${f2(trade.entryPrice)}</code>\n` +
    `Exit:      <code>$${f2(exitPrice)}</code>\n` +
    `P&amp;L:       <code>${pnlStr}</code>\n` +
    `Balance:   <code>$${f2(state.balance)}</code>\n` +
    `Return:    <code>${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%</code>`
  );
}

function checkSlTp(candle) {
  if (!state.openTrade) return;
  const t        = state.openTrade;
  const exitTime = new Date(candle.time * 1000).toISOString();
  if (t.direction === 'LONG') {
    if (candle.low  <= t.sl) { closeTrade(t, t.sl, exitTime, 'SL'); saveState(); return; }
    if (candle.high >= t.tp) { closeTrade(t, t.tp, exitTime, 'TP'); saveState(); return; }
  } else {
    if (candle.high >= t.sl) { closeTrade(t, t.sl, exitTime, 'SL'); saveState(); return; }
    if (candle.low  <= t.tp) { closeTrade(t, t.tp, exitTime, 'TP'); saveState(); return; }
  }
}

// ─── MAIN PROCESSING ────────────────────────────────────────
function processCandles(candles, wr) {
  const closedCount = candles.length - 1; // last candle is still building
  if (closedCount < 2) return;

  const lastClosed = candles[closedCount - 1];

  // Already up to date
  if (state.lastCandleOpen === lastClosed.time) return;

  // Find the first candle we haven't processed yet
  let startIdx = closedCount - 1; // default: only process last closed candle

  if (state.lastCandleOpen !== null) {
    const found = candles.findIndex(c => c.time === state.lastCandleOpen);
    if (found !== -1) {
      // Normal case: resume from next candle after last processed
      startIdx = found + 1;
    } else {
      // FIX 5: lastCandleOpen is older than our fetch window (bot was down too long).
      // Process all closed candles we have and log a warning.
      startIdx = 0;
      console.warn(
        `[WARN] Last processed candle not in fetch window — ` +
        `bot may have missed signals during downtime. Processing all ${closedCount} available candles.`
      );

      // Fix A: If there was a pending signal queued before the long downtime,
      // cancel it — we no longer know the right entry candle/price for it.
      if (state.pendingSignal) {
        console.warn(`[WARN] Cancelling stale pendingSignal (${state.pendingSignal.direction}) — too old to execute safely.`);
        sendTelegram(
          `⚠️ <b>Stale Signal Cancelled</b>\n` +
          `A pending <b>${state.pendingSignal.direction}</b> entry was queued before the bot went offline.\n` +
          `It has been cancelled because the intended entry candle is no longer available.\n` +
          `The bot will resume watching for new signals.`
        );
        state.pendingSignal = null;
        saveState();
      }

      sendTelegram(
        `⚠️ <b>Catch-up Warning</b>\n` +
        `Bot was offline long enough that some candles fell outside the fetch window.\n` +
        `Processing all <code>${closedCount}</code> available candles now.\n` +
        `Some signals during downtime may have been missed.`
      );
    }
  }

  for (let i = startIdx; i < closedCount; i++) {
    // Step 1: Execute pending entry from previous candle's signal
    if (state.pendingSignal !== null) {
      enterTrade(state.pendingSignal.direction, candles[i].open, candles[i]);
      state.pendingSignal = null;
      saveState();
    }

    // Step 2: Check SL/TP for any open trade
    if (state.openTrade) {
      checkSlTp(candles[i]);
    }

    // Step 3: Detect new signal on this closed candle
    if (i >= 1) {
      const signal = detectSignal(wr, i);
      if (signal !== 0) {
        const dir        = signal === 1 ? 'LONG' : 'SHORT';
        const filterPass = checkChikouFilter(candles, i, dir);

        if (filterPass) {
          if (state.openTrade) {
            if (state.openTrade.direction !== dir) {
              // TIMEOUT: close current trade, queue reversal entry
              closeTrade(
                state.openTrade,
                candles[i].close,
                new Date(candles[i].time * 1000).toISOString(),
                'TIMEOUT'
              );
              state.pendingSignal = { direction: dir };
              saveState();

              // FIX 3: Notify that a new signal was also queued after the timeout
              sendTelegram(
                `${dir === 'LONG' ? '🟢' : '🔴'} <b>REVERSAL SIGNAL — ${dir}</b>\n` +
                `WR:            <code>${wr[i].toFixed(1)}</code>\n` +
                `Chikou Filter: <code>PASS ✅</code>\n` +
                `BTC Price:     <code>$${f2(candles[i].close)}</code>\n` +
                `Entry fills at next candle open…`
              );
            }
            // Same direction as open trade: ignore silently
          } else {
            // No open trade: queue entry for next candle
            state.pendingSignal = { direction: dir };
            saveState();

            sendTelegram(
              `${dir === 'LONG' ? '🟢' : '🔴'} <b>SIGNAL FIRED — ${dir}</b>\n` +
              `WR:            <code>${wr[i].toFixed(1)}</code>\n` +
              `Chikou Filter: <code>PASS ✅</code>\n` +
              `BTC Price:     <code>$${f2(candles[i].close)}</code>\n` +
              `Entry fills at next candle open…`
            );
          }
        } else {
          sendTelegram(
            `⚠️ <b>SIGNAL SKIPPED — ${dir}</b>\n` +
            `WR:            <code>${wr[i].toFixed(1)}</code>\n` +
            `Chikou Filter: <code>FAIL ❌</code>\n` +
            `No trade taken.`
          );
        }
      }
    }
  }

  state.lastCandleOpen = lastClosed.time;
  saveState();
}

// ─── HELPERS ────────────────────────────────────────────────
function f2(n) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d  = new Date(iso);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function calcStats() {
  const trades    = state.trades;
  const balance   = state.balance;
  const ret       = ((balance - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const wins      = trades.filter(t => t.result === 'win').length;
  const losses    = trades.filter(t => t.result === 'loss').length;
  const winRate   = trades.length > 0 ? (wins / trades.length) * 100 : null;
  const grossWin  = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  const pf        = grossLoss > 0 ? grossWin / grossLoss : null;
  const avgWin    = wins   > 0 ? grossWin  / wins   : null;
  const avgLoss   = losses > 0 ? -(grossLoss / losses) : null;

  let peak = INITIAL_BALANCE, maxDd = 0;
  for (const t of [...trades].sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime))) {
    if (t.balanceAfter > peak) peak = t.balanceAfter;
    const dd = ((peak - t.balanceAfter) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  let maxConsecWins = 0, maxConsecLoss = 0, curW = 0, curL = 0;
  for (const t of trades) {
    if (t.result === 'win')       { curW++; curL = 0; maxConsecWins = Math.max(maxConsecWins, curW); }
    else if (t.result === 'loss') { curL++; curW = 0; maxConsecLoss = Math.max(maxConsecLoss, curL); }
  }

  return {
    balance, ret, wins, losses,
    total: trades.length,
    winRate, pf, maxDd,
    avgWin, avgLoss,
    maxConsecWins, maxConsecLoss,
    grossWin, grossLoss,
  };
}

// ─── COMMAND HANDLERS ───────────────────────────────────────
function handleStats() {
  const s     = calcStats();
  const price = lastCandles.length ? lastCandles[lastCandles.length - 1].close : null;
  const wrNow = lastWR !== null ? lastWR.toFixed(1) : '—';
  const wrZone = lastWR === null       ? '—'
    : lastWR >= -20                    ? '🔴 OVERBOUGHT'
    : lastWR <= -80                    ? '🟢 OVERSOLD'
    :                                    '⚪ NEUTRAL';

  let chikouStr = '—';
  if (lastCandles.length > CHIKOU_SHIFT) {
    const idx = lastCandles.length - 2;
    const lp  = checkChikouFilter(lastCandles, idx, 'LONG');
    const sp  = checkChikouFilter(lastCandles, idx, 'SHORT');
    chikouStr = lp ? '✅ LONG PASS' : sp ? '✅ SHORT PASS' : '❌ FAIL';
  }

  let upnlLine = '';
  if (state.openTrade && price) {
    const dir  = state.openTrade.direction === 'LONG' ? 1 : -1;
    const upnl = (price - state.openTrade.entryPrice) * state.openTrade.sizeBTC * dir;
    upnlLine   = `\nUnrealized P&amp;L: <code>${upnl >= 0 ? '+' : '-'}$${f2(Math.abs(upnl))}</code> ${upnl >= 0 ? '📈' : '📉'}`;
  }

  const pendingLine = state.pendingSignal
    ? `\n⏳ Pending Entry: <code>${state.pendingSignal.direction}</code> at next candle open`
    : '';

  const openLine = state.openTrade
    ? `${state.openTrade.direction} @ <code>$${f2(state.openTrade.entryPrice)}</code>`
    : 'None';
  const retSign = s.ret >= 0 ? '+' : '';

  return (
    `📊 <b>STRATEGY STATS — BTC/USDT 15m</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Account</b>\n` +
    `Balance:        <code>$${f2(s.balance)}</code>\n` +
    `Total Return:   <code>${retSign}${s.ret.toFixed(2)}%</code>  <code>(${retSign}$${f2(Math.abs(s.balance - INITIAL_BALANCE))})</code>\n` +
    `Open Trade:     ${openLine}${upnlLine}${pendingLine}\n\n` +
    `📈 <b>Performance</b>\n` +
    `Total Trades:   <code>${s.total}</code>  (${s.wins}W / ${s.losses}L)\n` +
    `Win Rate:       <code>${s.winRate !== null ? s.winRate.toFixed(1) + '%' : '—'}</code>\n` +
    `Profit Factor:  <code>${s.pf !== null ? s.pf.toFixed(2) + 'x' : '—'}</code>\n` +
    `Max Drawdown:   <code>${s.maxDd > 0 ? '-' + s.maxDd.toFixed(2) + '%' : '0%'}</code>\n` +
    `Avg Win:        <code>${s.avgWin  !== null ? '+$' + f2(s.avgWin)              : '—'}</code>\n` +
    `Avg Loss:       <code>${s.avgLoss !== null ? '-$' + f2(Math.abs(s.avgLoss))   : '—'}</code>\n` +
    `Best Streak:    <code>${s.maxConsecWins}W</code>  Worst: <code>${s.maxConsecLoss}L</code>\n` +
    `Gross Profit:   <code>+$${f2(s.grossWin)}</code>\n` +
    `Gross Loss:     <code>-$${f2(s.grossLoss)}</code>\n\n` +
    `📡 <b>Indicators (last closed candle)</b>\n` +
    `BTC Price:      <code>${price ? '$' + f2(price) : '—'}</code>\n` +
    `Williams %R:    <code>${wrNow}</code>  ${wrZone}\n` +
    `Chikou Filter:  ${chikouStr}`
  );
}

function handlePosition() {
  if (!state.openTrade) {
    const pendingLine = state.pendingSignal
      ? `\n⏳ <b>Pending:</b> ${state.pendingSignal.direction} entry queued for next candle open.`
      : '';
    return (
      `💤 <b>No open trade right now.</b>${pendingLine}\n\n` +
      `The bot is watching for the next Williams %R signal…\n` +
      `Send /stats to check indicators.`
    );
  }

  const t     = state.openTrade;
  const price = lastCandles.length ? lastCandles[lastCandles.length - 1].close : null;
  const dir   = t.direction === 'LONG' ? 1 : -1;
  const emoji = t.direction === 'LONG' ? '🟢' : '🔴';
  const upnl  = price ? (price - t.entryPrice) * t.sizeBTC * dir : null;

  const distSL = price ? Math.abs(((price - t.sl) / price) * 100).toFixed(2) : '—';
  const distTP = price ? Math.abs(((t.tp - price) / price) * 100).toFixed(2) : '—';

  const durationMin = Math.floor((Date.now() - new Date(t.entryTime).getTime()) / 60000);
  const durationStr = durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`;

  const rMult   = upnl !== null ? (upnl / RISK_USD).toFixed(2) : '—';
  const upnlLine = upnl !== null
    ? `<code>${upnl >= 0 ? '+' : '-'}$${f2(Math.abs(upnl))}</code>  <code>(${upnl >= 0 ? '+' : ''}${rMult}R)</code>  ${upnl >= 0 ? '📈' : '📉'}`
    : '—';

  return (
    `${emoji} <b>OPEN TRADE — ${t.direction} #${t.id}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Entry Price:    <code>$${f2(t.entryPrice)}</code>\n` +
    `Current Price:  <code>${price ? '$' + f2(price) : '—'}</code>\n\n` +
    `🛑 Stop Loss:   <code>$${f2(t.sl)}</code>  <i>(${distSL}% away)</i>\n` +
    `🎯 Take Profit: <code>$${f2(t.tp)}</code>  <i>(${distTP}% away)</i>\n\n` +
    `Unrealized P&amp;L: ${upnlLine}\n` +
    `Position Size:  <code>${t.sizeBTC.toFixed(6)} BTC</code>\n` +
    `Risk:           <code>$${RISK_USD}</code>\n` +
    `Duration:       <code>${durationStr}</code>\n` +
    `Entered:        <code>${fmtDate(t.entryTime)} UTC</code>`
  );
}

// FIX 4: Split history into chunks to avoid Telegram's 4096 char limit
function handleHistory(n = 20) {
  const trades = state.trades;
  if (trades.length === 0)
    return `📋 <b>No closed trades yet.</b>\n\nThe bot is actively watching for signals.\nSend /stats to see indicators.`;

  const recent = [...trades].reverse().slice(0, n);
  const s      = calcStats();
  const retSign = s.ret >= 0 ? '+' : '';

  const header =
    `📋 <b>TRADE HISTORY — Last ${recent.length}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n`;

  const footer =
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Showing <code>${recent.length}</code> of <code>${trades.length}</code> total trades\n` +
    `Balance: <code>$${f2(s.balance)}</code>  <code>${retSign}${s.ret.toFixed(2)}%</code>\n` +
    `W/L: <code>${s.wins}/${s.losses}</code>  ` +
    `WR: <code>${s.winRate !== null ? s.winRate.toFixed(1) + '%' : '—'}</code>  ` +
    `PF: <code>${s.pf !== null ? s.pf.toFixed(2) + 'x' : '—'}</code>`;

  const lines = recent.map(t => {
    const emoji   = t.result === 'win' ? '✅' : t.result === 'loss' ? '❌' : '⚪';
    const dirTag  = t.direction === 'LONG' ? '↑' : '↓';
    const pnlSign = t.pnl >= 0 ? '+' : '-';
    const via     = t.exitVia === 'TP' ? '🎯' : t.exitVia === 'SL' ? '🛑' : '⏱';
    return (
      `${emoji} <b>#${t.id}</b> ${dirTag}${t.direction}  ${via} ${t.exitVia}\n` +
      `   <code>${fmtDate(t.entryTime)}</code> → <code>${fmtDate(t.exitTime)} UTC</code>\n` +
      `   Entry <code>$${f2(t.entryPrice)}</code> → Exit <code>$${f2(t.exitPrice)}</code>\n` +
      `   P&amp;L <code>${pnlSign}$${f2(Math.abs(t.pnl))}</code>   Bal <code>$${f2(t.balanceAfter)}</code>`
    );
  });

  // Build pages under 3800 chars each (safe margin below Telegram's 4096 limit)
  const pages = [];
  let current = header;
  for (let i = 0; i < lines.length; i++) {
    const chunk = (i === 0 ? '' : '\n\n') + lines[i];
    const isLast = i === lines.length - 1;
    const withFooter = current + chunk + '\n\n' + footer;
    if (withFooter.length <= 3800 || isLast) {
      current += chunk;
      if (isLast) pages.push(current + '\n\n' + footer);
    } else {
      pages.push(current);
      current = `📋 <b>TRADE HISTORY (cont.)</b>\n━━━━━━━━━━━━━━━━━━━━━\n` + lines[i];
    }
  }

  return pages; // array of strings — caller sends each one
}

function handleHelp() {
  return (
    `🤖 <b>BTC Paper Trader — Commands</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `/stats          Full performance stats, indicators &amp; balance\n` +
    `/position       Current open trade with live P&amp;L\n` +
    `/history        Last 20 closed trades\n` +
    `/history [N]    Last N closed trades (max 50)\n` +
    `/help           Show this message\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Auto alerts:</b>\n` +
    `🟢🔴  Signal fired (with filter result)\n` +
    `⚠️     Signal skipped (filter failed)\n` +
    `📈📉  Trade opened\n` +
    `✅❌  Trade closed (TP / SL / Timeout)\n` +
    `📊    Daily report at 00:00 UTC\n` +
    `⚠️     Catch-up warning if bot was offline too long\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Strategy: Williams %R(14) + Ichimoku Chikou</i>\n` +
    `<i>SL: 1.5%  |  TP: 3.0%  |  Risk: $10/trade</i>`
  );
}

// ─── TELEGRAM SEND ──────────────────────────────────────────
async function sendTelegram(text, chatId = TELEGRAM_CHAT_ID) {
  if (!TELEGRAM_TOKEN || !chatId) {
    console.log('[TELEGRAM DISABLED]', text.replace(/<[^>]+>/g, ''));
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('Telegram API error:', await res.text());
  } catch (e) { console.error('Telegram send error:', e.message); }
}

// Send one or more messages (handles array from handleHistory)
async function sendReply(textOrPages, chatId = TELEGRAM_CHAT_ID) {
  const pages = Array.isArray(textOrPages) ? textOrPages : [textOrPages];
  for (const page of pages) {
    await sendTelegram(page, chatId);
  }
}

// ─── TELEGRAM POLLING ───────────────────────────────────────
let pollingOffset = 0;

async function pollCommands() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates` +
      `?offset=${pollingOffset}&timeout=20&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(25000) }
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.result.length) return;

    for (const update of data.result) {
      pollingOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = String(msg.chat.id);
      const text   = msg.text.trim().toLowerCase().split('@')[0];

      if (TELEGRAM_CHAT_ID && chatId !== String(TELEGRAM_CHAT_ID)) {
        await sendTelegram('⛔ Unauthorized.', chatId);
        continue;
      }

      console.log(`[CMD] ${chatId}: ${text}`);

      if (text === '/stats' || text === '/start') {
        await sendReply(handleStats(), chatId);
      } else if (text === '/position' || text === '/pos') {
        await sendReply(handlePosition(), chatId);
      } else if (text.startsWith('/history')) {
        const parts = text.split(' ');
        const n     = Math.min(Math.max(parseInt(parts[1]) || 20, 1), 50);
        await sendReply(handleHistory(n), chatId);
      } else if (text === '/help') {
        await sendReply(handleHelp(), chatId);
      } else {
        await sendTelegram(
          `❓ Unknown command: <code>${msg.text}</code>\n\nSend /help to see available commands.`,
          chatId
        );
      }
    }
  } catch (e) {
    if (!e.message.includes('timeout') && !e.message.includes('abort'))
      console.error('Polling error:', e.message);
  }
}

async function startPolling() {
  while (true) {
    await pollCommands();
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function registerCommands() {
  if (!TELEGRAM_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setMyCommands`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        commands: [
          { command: 'stats',    description: 'Full performance stats & indicators' },
          { command: 'position', description: 'Current open trade & live P&L' },
          { command: 'history',  description: 'Last 20 closed trades' },
          { command: 'help',     description: 'List all commands' },
        ],
      }),
    });
    console.log('Telegram commands registered ✅');
  } catch (e) { console.error('Could not register commands:', e.message); }
}

// ─── MAIN TICK ──────────────────────────────────────────────
// FIX 6: Track daily report with a flag so a failed tick doesn't permanently
// block the report — it will retry on the next 30s tick within the same minute.
let dailyReportSentForDay = null;

async function tick() {
  try {
    const candles = await fetchCandles();
    const wr      = calcWilliamsR(candles);
    lastCandles   = candles;
    lastWR        = wr[wr.length - 2] ?? null;

    processCandles(candles, wr);

    // Daily status at 00:00 UTC — retries every 30s within the first minute
    const now    = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    if (
      now.getUTCHours() === 0 &&
      now.getUTCMinutes() === 0 &&
      dailyReportSentForDay !== dayKey
    ) {
      dailyReportSentForDay = dayKey;
      await sendReply(handleStats());
    }

    const price = candles[candles.length - 1].close;
    console.log(
      `[${new Date().toISOString()}]`,
      `BTC $${f2(price)}`,
      `WR: ${lastWR !== null ? lastWR.toFixed(1) : '—'}`,
      `Balance: $${f2(state.balance)}`,
      state.openTrade     ? `Open: ${state.openTrade.direction}` : '',
      state.pendingSignal ? `Pending: ${state.pendingSignal.direction}` : 'No trade'
    );
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Tick error:`, e.message);
  }
}

// ─── HTTP API SERVER ─────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

app.get('/state', (req, res) => res.json({
  balance:        state.balance,
  trades:         state.trades,
  openTrade:      state.openTrade,
  pendingSignal:  state.pendingSignal,
  initialBalance: INITIAL_BALANCE,
  updatedAt:      new Date().toISOString(),
}));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.listen(PORT, () => console.log(`API server listening on port ${PORT}`));

// ─── START ──────────────────────────────────────────────────
console.log('🤖 BTC Paper Trader Bot starting…');
console.log(`   Telegram:   ${TELEGRAM_TOKEN   ? 'configured ✅' : 'NOT SET ⚠️'}`);
console.log(`   Chat ID:    ${TELEGRAM_CHAT_ID ? 'configured ✅' : 'NOT SET ⚠️'}`);
console.log(`   State file: ${STATE_FILE}`);
console.log(`   Candle limit: ${CANDLE_LIMIT}`);
if (state.pendingSignal) {
  console.log(`   Restored pending signal: ${state.pendingSignal.direction}`);
}

await registerCommands();
await sendTelegram(
  '🤖 <b>BTC Paper Trader Bot started</b>\n' +
  'Monitoring BTC/USDT 15m…\n' +
  'Strategy: Williams %R + Ichimoku Chikou\n' +
  (state.pendingSignal
    ? `\n⏳ Restored pending <b>${state.pendingSignal.direction}</b> entry from before restart.`
    : '') +
  '\n\nSend /help for available commands.'
);

tick();
setInterval(tick, POLL_INTERVAL_MS);
startPolling();