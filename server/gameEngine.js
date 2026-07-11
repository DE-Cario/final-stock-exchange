// server/gameEngine.js
//
// Holds all game state in memory and exposes methods to mutate it safely.
// State is persisted to data/gamestate.json on every change (see db.js).
//
// PRICING MODEL (read this before changing numbers):
// - Each season "block" has a target % move per company (from the calendar).
// - At block start we snapshot the price, compute a target price, and split
//   the journey into small fixed steps applied every TICK_MS. This creates a
//   smooth seasonal drift instead of an instant jump.
// - Surprise events (admin-triggered) apply an INSTANT multiplicative % change
//   on top of whatever the price currently is, independent of the drift step.
//   This is what makes surprises feel like real shocks layered on a trend.

const { loadState, saveState, saveStateSync } = require('./db');
const defaultCompanies = require('./defaultCompanies');
const defaultCalendar = require('./defaultCalendar');
const crypto = require('crypto');

const TICK_MS = 3000; // how often prices recalculate during a running block
const FEE_RATE = 0.01; // 1% per trade
const MAX_SURPRISE_PCT = 30; // cap on any single surprise event
const PRICE_FLOOR = 10; // ₹ minimum price per share
const STARTING_CASH = 50000;

function buildDefaultState() {
  const companies = {};
  defaultCompanies.forEach((c) => {
    companies[c.id] = {
      id: c.id,
      name: c.name,
      icon: c.icon,
      startPrice: c.price,
      price: c.price
    };
  });
  return {
    status: 'lobby', // lobby | running | paused | ended
    companies,
    calendar: defaultCalendar,
    currentBlockIndex: -1,
    blockStartedAt: null,
    blockDriftStep: {}, // companyId -> per-tick increment for current block
    blockTicksRemaining: 0,
    blockHistory: [], // snapshots of each completed block for awards calc
    sessionStartedAt: null,
    pausedAt: null,
    totalPausedMs: 0,
    durationMinutesPlanned: defaultCalendar.reduce((a, b) => a + b.durationMinutes, 0),
    news: [],
    surpriseEvents: [],
    teams: {}, // teamId -> team record
    nextTeamNum: 1
  };
}

function hashPinValue(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPinStored(stored, pin) {
  if (!stored) return false;
  if (typeof stored === 'string') return stored === String(pin).trim();
  // stored is an object {salt, hash}
  try {
    const hash = crypto.scryptSync(String(pin), stored.salt, 64).toString('hex');
    return hash === stored.hash;
  } catch (err) {
    return false;
  }
}

class GameEngine {
  constructor(io) {
    this.io = io;
    this.state = loadState(buildDefaultState());
    this._tickHandle = null;
  }

  // ---------- persistence ----------
  persist() {
    saveState(this.state);
  }

  // ---------- public state for investor/projector views ----------
  getPublicState() {
    const s = this.state;
    const block = s.currentBlockIndex >= 0 ? s.calendar[s.currentBlockIndex] : null;
    let timeRemainingMs = null;
    if (block && s.blockStartedAt && s.status === 'running') {
      const elapsed = Date.now() - s.blockStartedAt;
      timeRemainingMs = Math.max(0, block.durationMinutes * 60000 - elapsed);
    }
    const companies = Object.values(s.companies).map((c) => {
      const blockStart = this._currentBlockStartPrice(c.id);
      const pctChange = blockStart ? (((c.price - blockStart) / blockStart) * 100) : 0;
      return {
        id: c.id,
        name: c.name,
        icon: c.icon,
        price: Math.round(c.price * 100) / 100,
        pctChangeThisBlock: Math.round(pctChange * 10) / 10
      };
    });
    return {
      status: s.status,
      blockLabel: block ? block.label : (s.status === 'ended' ? 'Market Closed' : 'Market Not Open Yet'),
      blockIndex: s.currentBlockIndex,
      totalBlocks: s.calendar.length,
      timeRemainingMs,
      companies,
      news: s.news.slice(-15).reverse(),
      leaderboard: this.computeLeaderboard().slice(0, 10)
    };
  }

  _currentBlockStartPrice(companyId) {
    const s = this.state;
    if (s.currentBlockIndex < 0) return s.companies[companyId].startPrice;
    const hist = s.blockHistory[s.currentBlockIndex];
    if (hist) return hist.startPrices[companyId];
    // block in progress, not yet in history -> use stored snapshot
    return s._inProgressStartPrices ? s._inProgressStartPrices[companyId] : s.companies[companyId].price;
  }

  // ---------- team management ----------
  generateTeams(names) {
    const created = [];
    names.forEach((name) => {
      const teamId = 'T' + String(this.state.nextTeamNum).padStart(3, '0');
      this.state.nextTeamNum += 1;
      const plainPin = String(Math.floor(100000 + Math.random() * 900000));
      const storedPin = hashPinValue(plainPin);
      this.state.teams[teamId] = {
        teamId,
        teamName: name.trim(),
        pin: storedPin,
        cash: STARTING_CASH,
        holdings: {},
        trades: []
      };
      // return plain PIN to admin for distribution, but store only hashed
      created.push({ teamId, teamName: name.trim(), pin: plainPin });
    });
    this.persist();
    return created;
  }

  login(teamName, pin) {
    const team = Object.values(this.state.teams).find(
      (t) => t.teamName.toLowerCase() === String(teamName).trim().toLowerCase()
    );
    if (!team) return null;
    // verify stored pin (supports legacy plain-text pins and new hashed pins)
    if (verifyPinStored(team.pin, pin)) {
      // migrate legacy plain-text pin to hashed format
      if (typeof team.pin === 'string') {
        team.pin = hashPinValue(pin);
        this.persist();
      }
      return team;
    }
    return null;
  }

  createTeam(teamName, pin) {
    if (!teamName || !pin) return { ok: false, error: 'teamName and pin required' };
    const name = String(teamName).trim();
    // prevent duplicate names (case-insensitive)
    const exists = Object.values(this.state.teams).some((t) => t.teamName.toLowerCase() === name.toLowerCase());
    if (exists) return { ok: false, error: 'Team name already taken' };
    // PIN must be exactly 6 digits
    if (!/^\d{6}$/.test(String(pin).trim())) {
      return { ok: false, error: 'PIN must be exactly 6 digits' };
    }
    const teamId = 'T' + String(this.state.nextTeamNum).padStart(3, '0');
    this.state.nextTeamNum += 1;
    const storedPin = hashPinValue(pin);
    this.state.teams[teamId] = {
      teamId,
      teamName: name,
      pin: storedPin,
      cash: STARTING_CASH,
      holdings: {},
      trades: []
    };
    this.persist();
    return { ok: true, teamId };
  }

  // admin: update team name or PIN
  updateTeam(teamId, { teamName, pin }) {
    const team = this.state.teams[teamId];
    if (!team) return { ok: false, error: 'Team not found' };
    if (teamName) {
      const name = String(teamName).trim();
      // prevent duplicate names (case-insensitive) unless same team
      const exists = Object.values(this.state.teams).some((t) => t.teamId !== teamId && t.teamName.toLowerCase() === name.toLowerCase());
      if (exists) return { ok: false, error: 'Team name already taken' };
      team.teamName = name;
    }
    if (pin) {
      if (!/^\d{6}$/.test(String(pin).trim())) return { ok: false, error: 'PIN must be exactly 6 digits' };
      team.pin = hashPinValue(pin);
    }
    this.persist();
    return { ok: true };
  }

  removeTeam(teamId) {
    if (!this.state.teams[teamId]) return { ok: false, error: 'Team not found' };
    delete this.state.teams[teamId];
    this.persist();
    this._broadcastLeaderboard();
    return { ok: true };
  }

  getTeamPortfolio(teamId) {
    const team = this.state.teams[teamId];
    if (!team) return null;
    const holdings = Object.entries(team.holdings).map(([companyId, qty]) => {
      const company = this.state.companies[companyId];
      return {
        companyId,
        name: company.name,
        icon: company.icon,
        qty,
        currentPrice: Math.round(company.price * 100) / 100,
        value: Math.round(qty * company.price * 100) / 100
      };
    });
    const holdingsValue = holdings.reduce((a, h) => a + h.value, 0);
    return {
      teamId: team.teamId,
      teamName: team.teamName,
      cash: Math.round(team.cash * 100) / 100,
      holdings,
      holdingsValue: Math.round(holdingsValue * 100) / 100,
      totalValue: Math.round((team.cash + holdingsValue) * 100) / 100
    };
  }

  // ---------- trading ----------
  trade(teamId, companyId, action, qty) {
    const team = this.state.teams[teamId];
    if (!team) return { ok: false, error: 'Team not found' };
    const company = this.state.companies[companyId];
    if (!company) return { ok: false, error: 'Company not found' };
    qty = parseInt(qty, 10);
    if (!qty || qty <= 0) return { ok: false, error: 'Quantity must be a positive whole number' };
    if (this.state.status !== 'running') return { ok: false, error: 'Market is not currently open' };

    const price = company.price;
    if (action === 'buy') {
      const cost = qty * price;
      const fee = cost * FEE_RATE;
      const total = cost + fee;
      if (team.cash < total) return { ok: false, error: 'Insufficient funds' };
      team.cash -= total;
      team.holdings[companyId] = (team.holdings[companyId] || 0) + qty;
      team.trades.push({
        timestamp: Date.now(),
        companyId,
        action: 'buy',
        qty,
        price,
        fee: Math.round(fee * 100) / 100,
        blockIndex: this.state.currentBlockIndex
      });
    } else if (action === 'sell') {
      const owned = team.holdings[companyId] || 0;
      if (qty > owned) return { ok: false, error: 'You do not own that many shares' };
      const proceeds = qty * price;
      const fee = proceeds * FEE_RATE;
      const net = proceeds - fee;
      team.cash += net;
      team.holdings[companyId] -= qty;
      if (team.holdings[companyId] === 0) delete team.holdings[companyId];
      team.trades.push({
        timestamp: Date.now(),
        companyId,
        action: 'sell',
        qty,
        price,
        fee: Math.round(fee * 100) / 100,
        blockIndex: this.state.currentBlockIndex
      });
    } else if (action === 'short') {
      const proceeds = qty * price;
      const fee = proceeds * FEE_RATE;
      const net = proceeds - fee;
      team.cash += net;
      team.holdings[companyId] = (team.holdings[companyId] || 0) - qty;
      if (team.holdings[companyId] === 0) delete team.holdings[companyId];
      team.trades.push({
        timestamp: Date.now(),
        companyId,
        action: 'short',
        qty,
        price,
        fee: Math.round(fee * 100) / 100,
        blockIndex: this.state.currentBlockIndex
      });
    } else {
      return { ok: false, error: 'Invalid action' };
    }
    this.persist();
    this._broadcastLeaderboard();
    return { ok: true, portfolio: this.getTeamPortfolio(teamId) };
  }

  // ---------- leaderboard & awards ----------
  computeLeaderboard() {
    const rows = Object.values(this.state.teams).map((team) => {
      const holdingsValue = Object.entries(team.holdings).reduce((sum, [companyId, qty]) => {
        return sum + qty * this.state.companies[companyId].price;
      }, 0);
      return {
        teamId: team.teamId,
        teamName: team.teamName,
        cash: Math.round(team.cash * 100) / 100,
        holdingsValue: Math.round(holdingsValue * 100) / 100,
        totalValue: Math.round((team.cash + holdingsValue) * 100) / 100
      };
    });
    rows.sort((a, b) => b.totalValue - a.totalValue);
    return rows;
  }

  computeAwards() {
    const leaderboard = this.computeLeaderboard();
    const topInvestor = leaderboard[0] || null;

    // Best Seasonal Read: profit from buys made in the first 25% of a block,
    // valued at that block's end price, approximated as still held.
    let bestSeasonalRead = null;
    Object.values(this.state.teams).forEach((team) => {
      let total = 0;
      team.trades.forEach((trade) => {
        if (trade.action !== 'buy') return;
        const hist = this.state.blockHistory[trade.blockIndex];
        if (!hist) return;
        const blockDurationMs = this.state.calendar[trade.blockIndex].durationMinutes * 60000;
        const intoBlock = trade.timestamp - hist.startedAt;
        if (intoBlock < 0 || intoBlock > blockDurationMs * 0.25) return; // only "early" buys count
        const endPrice = hist.endPrices[trade.companyId];
        const profit = (endPrice - trade.price) * trade.qty;
        if (profit > 0) total += profit;
      });
      if (!bestSeasonalRead || total > bestSeasonalRead.total) {
        bestSeasonalRead = { teamId: team.teamId, teamName: team.teamName, total: Math.round(total * 100) / 100 };
      }
    });

    // Sharpest Reflexes: profit from buys made within 60s after a positive
    // surprise event on that company, valued at the final price.
    let sharpestReflexes = null;
    Object.values(this.state.teams).forEach((team) => {
      let total = 0;
      team.trades.forEach((trade) => {
        if (trade.action !== 'buy') return;
        const qualifyingEvent = this.state.surpriseEvents.find(
          (ev) => ev.companyId === trade.companyId && ev.pct > 0 &&
            trade.timestamp >= ev.timestamp && trade.timestamp <= ev.timestamp + 60000
        );
        if (!qualifyingEvent) return;
        const finalPrice = this.state.companies[trade.companyId].price;
        const profit = (finalPrice - trade.price) * trade.qty;
        if (profit > 0) total += profit;
      });
      if (!sharpestReflexes || total > sharpestReflexes.total) {
        sharpestReflexes = { teamId: team.teamId, teamName: team.teamName, total: Math.round(total * 100) / 100 };
      }
    });

    return { topInvestor, bestSeasonalRead, sharpestReflexes };
  }

  _broadcastLeaderboard() {
    if (this.io) this.io.emit('leaderboard_update', this.computeLeaderboard().slice(0, 10));
  }

  // ---------- admin: calendar & companies (only safe to edit pre-game) ----------
  replaceCalendar(newCalendar) {
    this.state.calendar = newCalendar;
    this.state.durationMinutesPlanned = newCalendar.reduce((a, b) => a + b.durationMinutes, 0);
    this.persist();
  }

  replaceCompanies(newCompanies) {
    const companies = {};
    newCompanies.forEach((c) => {
      companies[c.id] = { id: c.id, name: c.name, icon: c.icon || '🏢', startPrice: c.price, price: c.price };
    });
    this.state.companies = companies;
    this.persist();
  }

  // ---------- admin: game flow control ----------
  resetGame() {
    this._stopTicking();
    this.state = buildDefaultState();
    this.persist();
    this._broadcastState();
    return { ok: true };
  }

  startGame() {
    if (this.state.status !== 'lobby') return { ok: false, error: 'Game already started' };
    this.state.status = 'running';
    this.state.sessionStartedAt = Date.now();
    this._startBlock(0);
    this._startTicking();
    this._pushNews('🔔 Market is open! Trading has begun.');
    return { ok: true };
  }

  pauseGame() {
    if (this.state.status !== 'running') return { ok: false, error: 'Not running' };
    this.state.status = 'paused';
    this.state.pausedAt = Date.now();
    this._stopTicking();
    this._pushNews('⏸️ Market paused by admin.');
    return { ok: true };
  }

  resumeGame() {
    if (this.state.status !== 'paused') return { ok: false, error: 'Not paused' };
    const pausedMs = Date.now() - this.state.pausedAt;
    this.state.totalPausedMs += pausedMs;
    this.state.blockStartedAt += pausedMs; // shift block clock forward by paused duration
    this.state.status = 'running';
    this.state.pausedAt = null;
    this._startTicking();
    this._pushNews('▶️ Market resumed.');
    return { ok: true };
  }

  advanceBlock() {
    if (this.state.status !== 'running' && this.state.status !== 'paused') {
      return { ok: false, error: 'Game is not active' };
    }
    this._endCurrentBlock();
    const next = this.state.currentBlockIndex + 1;
    if (next >= this.state.calendar.length) {
      return this.endGame();
    }
    this._startBlock(next);
    return { ok: true };
  }

  endGame() {
    this._endCurrentBlock();
    this.state.status = 'ended';
    this._stopTicking();
    this._pushNews('🏁 Market closed. Final results are in!');
    this.persist();
    return { ok: true, awards: this.computeAwards() };
  }

  _startBlock(index) {
    const block = this.state.calendar[index];
    this.state.currentBlockIndex = index;
    this.state.blockStartedAt = Date.now();
    const startPrices = {};
    Object.values(this.state.companies).forEach((c) => { startPrices[c.id] = c.price; });
    this.state._inProgressStartPrices = startPrices;

    const numTicks = Math.max(1, Math.ceil((block.durationMinutes * 60000) / TICK_MS));
    const driftStep = {};
    block.moves.forEach((m) => {
      const startPrice = startPrices[m.companyId];
      if (startPrice === undefined) return;
      const targetPrice = startPrice * (1 + m.pct / 100);
      driftStep[m.companyId] = (targetPrice - startPrice) / numTicks;
    });
    this.state.blockDriftStep = driftStep;
    this.state.blockTicksRemaining = numTicks;
    this._pushNews(`📅 New season: ${block.label}`);
    this.persist();
  }

  _endCurrentBlock() {
    if (this.state.currentBlockIndex < 0) return;
    const idx = this.state.currentBlockIndex;
    const endPrices = {};
    Object.values(this.state.companies).forEach((c) => { endPrices[c.id] = c.price; });
    this.state.blockHistory[idx] = {
      label: this.state.calendar[idx].label,
      startedAt: this.state.blockStartedAt,
      endedAt: Date.now(),
      startPrices: this.state._inProgressStartPrices,
      endPrices
    };
    this.persist();
  }

  // ---------- admin: surprise events ----------
  triggerSurprise(companyId, headline, pct) {
    const company = this.state.companies[companyId];
    if (!company) return { ok: false, error: 'Company not found' };
    let clamped = Math.max(-MAX_SURPRISE_PCT, Math.min(MAX_SURPRISE_PCT, Number(pct)));
    const newPrice = Math.max(PRICE_FLOOR, company.price * (1 + clamped / 100));
    company.price = newPrice;
    this.state.surpriseEvents.push({
      timestamp: Date.now(),
      companyId,
      pct: clamped,
      headline
    });
    this._pushNews(`📰 ${headline} — ${company.name} ${clamped >= 0 ? '+' : ''}${clamped}%`);
    this.persist();
    this._broadcastState();
    return { ok: true };
  }

  // ---------- ticking (seasonal drift) ----------
  _startTicking() {
    this._stopTicking();
    this._tickHandle = setInterval(() => this._tick(), TICK_MS);
  }

  _stopTicking() {
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
  }

  _tick() {
    if (this.state.status !== 'running') return;
    const block = this.state.calendar[this.state.currentBlockIndex];
    if (!block) return;

    const elapsed = Date.now() - this.state.blockStartedAt;
    const durationMs = block.durationMinutes * 60000;

    Object.entries(this.state.blockDriftStep).forEach(([companyId, step]) => {
      const company = this.state.companies[companyId];
      if (!company) return;
      company.price = Math.max(PRICE_FLOOR, company.price + step);
    });

    this.persist();
    this._broadcastState();

    if (elapsed >= durationMs) {
      this.advanceBlock();
    }
  }

  _pushNews(headline) {
    this.state.news.push({ id: Date.now() + Math.random(), timestamp: Date.now(), headline });
    if (this.state.news.length > 200) this.state.news.shift();
  }

  _broadcastState() {
    if (this.io) this.io.emit('state_update', this.getPublicState());
  }

  // ---------- export ----------
  exportResultsCSV() {
    const rows = this.computeLeaderboard();
    const header = 'Rank,Team Name,Cash,Holdings Value,Total Value\n';
    const body = rows
      .map((r, i) => `${i + 1},${r.teamName},${r.cash},${r.holdingsValue},${r.totalValue}`)
      .join('\n');
    return header + body;
  }

  exportTeamsCSV() {
    const rows = Object.values(this.state.teams);
    const header = 'Team Name,Team ID\n';
    const body = rows.map((t) => `${t.teamName},${t.teamId}`).join('\n');
    return header + body;
  }
}

module.exports = { GameEngine, STARTING_CASH, FEE_RATE, buildDefaultState };
