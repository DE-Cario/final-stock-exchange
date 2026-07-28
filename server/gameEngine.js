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
const SETUP2_TRADE_MOVE_PCT = 1; // setup-2 price move per successful buy/sell

function buildDefaultState() {
  const companies = {};
  defaultCompanies.forEach((c) => {
    companies[c.id] = {
      id: c.id,
      name: c.name,
      icon: c.icon,
      startPrice: c.price,
      price: c.price,
      totalShares: 10000,
      adminAllocation: 5000
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
    nextTeamNum: 1,
    setup2Config: null,
    setup2Active: false,
    adminHoldings: {},
    adminCash: null
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

  persistSync() {
    saveStateSync(this.state);
  }

  setSetup2Config(config) {
    if (!config || !config.hasOwnProperty('companies') || !config.hasOwnProperty('calendar')) {
      return { ok: false, error: 'Setup-2 config requires companies and calendar' };
    }

    const fallbackCompanies = Object.values(this.state.companies || {}).map((company) => ({
      id: company.id,
      name: company.name,
      icon: company.icon || '🏢',
      price: 100,
      totalShares: 10000,
      adminAllocation: 5000
    }));

    const sourceCompanies = Array.isArray(config.companies) && config.companies.length > 0
      ? config.companies
      : fallbackCompanies;

    const normalizedCompanies = sourceCompanies.map((company) => {
      const price = Number(company.price || 100);
      const totalShares = Number(company.totalShares || 10000);
      const adminAllocation = Math.min(totalShares, Math.max(0, Number(company.adminAllocation || Math.floor(totalShares * 0.5))));
      return {
        id: String(company.id || `co_${Math.random().toString(36).slice(2, 8)}`),
        name: String(company.name || 'Company'),
        icon: company.icon || '🏢',
        price: price > 0 ? price : 100,
        totalShares: totalShares > 0 ? totalShares : 10000,
        adminAllocation
      };
    });

    const sourceCalendar = Array.isArray(config.calendar) && config.calendar.length > 0
      ? config.calendar
      : Array.from({ length: 5 }, (_, idx) => ({ label: `Round ${idx + 1}`, durationMinutes: 5, moves: [] }));

    const normalizedCalendar = sourceCalendar.slice(0, 5).map((block, idx) => ({
      label: block.label || `Round ${idx + 1}`,
      durationMinutes: Math.max(1, Number(block.durationMinutes || 5)),
      moves: []
    }));

    this.state.setup2Config = {
      companies: normalizedCompanies,
      calendar: normalizedCalendar
    };
    this.state.setup2Active = false;
    this.state.adminHoldings = {};
    this.state.adminCash = null;
    this.persist();
    return { ok: true };
  }

  getAdminPortfolio() {
    const holdings = Object.entries(this.state.adminHoldings || {})
      .filter(([, qty]) => Number(qty) > 0)
      .map(([companyId, qty]) => {
        const company = this.state.companies[companyId];
        if (!company) return null;
        const currentPrice = Math.round(company.price * 100) / 100;
        return {
          companyId,
          name: company.name,
          icon: company.icon,
          boughtQty: Number(qty),
          shortedQty: 0,
          netQty: Number(qty),
          currentPrice,
          value: Math.round(Number(qty) * currentPrice * 100) / 100
        };
      })
      .filter(Boolean);

    const holdingsValue = holdings.reduce((sum, item) => sum + item.value, 0);
    return {
      cash: this.state.adminCash === null || this.state.adminCash === undefined ? Infinity : this.state.adminCash,
      holdings,
      holdingsValue: Math.round(holdingsValue * 100) / 100,
      totalValue: Infinity
    };
  }

  tradeAdmin(companyId, action, qty) {
    const company = this.state.companies[companyId];
    if (!company) return { ok: false, error: 'Company not found' };
    qty = parseInt(qty, 10);
    if (!qty || qty <= 0) return { ok: false, error: 'Quantity must be a positive whole number' };
    if (action !== 'buy' && action !== 'sell') return { ok: false, error: 'Invalid action' };

    const currentHoldings = Number(this.state.adminHoldings[companyId] || 0);
    if (action === 'buy') {
      const totalLongs = this._getCompanyLongHoldings(companyId);
      const totalShares = Number(company.totalShares || 10000);
      if (totalLongs + qty > totalShares) {
        return { ok: false, error: 'Not enough shares available' };
      }
      this.state.adminHoldings[companyId] = currentHoldings + qty;
    } else if (action === 'sell') {
      if (currentHoldings < qty) return { ok: false, error: 'Admin does not own that many shares' };
      this.state.adminHoldings[companyId] = currentHoldings - qty;
    }

    this._applySupplyDemandPriceMove(company, action, qty);

    this.persist();
    this._broadcastLeaderboard();
    this._broadcastState();
    return { ok: true, portfolio: this.getAdminPortfolio() };
  }

  startSetup2Game() {
    if (!this.state.setup2Config) return { ok: false, error: 'Setup-2 config not saved yet' };
    if (this.state.status !== 'lobby') return { ok: false, error: 'Game already started' };

    const companies = {};
    this.state.setup2Config.companies.forEach((company) => {
      companies[company.id] = {
        id: company.id,
        name: company.name,
        icon: company.icon || '🏢',
        startPrice: company.price,
        price: company.price,
        totalShares: company.totalShares,
        adminAllocation: company.adminAllocation
      };
    });

    this.state.companies = companies;
    this.state.calendar = this.state.setup2Config.calendar;
    this.state.durationMinutesPlanned = this.state.calendar.reduce((sum, block) => sum + block.durationMinutes, 0);
    this.state.setup2Active = true;
    this.state.currentBlockIndex = -1;
    this.state.blockStartedAt = null;
    this.state.blockDriftStep = {};
    this.state.blockTicksRemaining = 0;
    this.state.blockHistory = [];
    this.state.sessionStartedAt = Date.now();
    this.state.pausedAt = null;
    this.state.totalPausedMs = 0;
    this.state.news = [];
    this.state.surpriseEvents = [];
    this.state.teams = {};
    this.state.nextTeamNum = 1;
    this.state.adminHoldings = {};
    this.state.adminCash = null;
    Object.values(companies).forEach((company) => {
      this.state.adminHoldings[company.id] = company.adminAllocation || Math.floor((company.totalShares || 10000) * 0.5);
    });

    this.state.status = 'running';
    this._startBlock(0);
    this._startTicking();
    this._pushNews('🔔 Setup-2 market is open! Trading has begun.');
    this.persist();
    return { ok: true };
  }

  // ---------- public state for investor/projector views ----------
  getPublicState() {
    const s = this.state;
    const block = s.currentBlockIndex >= 0 ? s.calendar[s.currentBlockIndex] : null;
    let timeRemainingMs = null;
    if (block && s.blockStartedAt) {
      if (s.status === 'running') {
        const elapsed = Date.now() - s.blockStartedAt;
        timeRemainingMs = Math.max(0, block.durationMinutes * 60000 - elapsed);
      } else if (s.status === 'paused' && s.pausedAt) {
        const elapsed = s.pausedAt - s.blockStartedAt;
        timeRemainingMs = Math.max(0, block.durationMinutes * 60000 - elapsed);
      }
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
    if (!s.companies[companyId]) return 100;
    if (s.currentBlockIndex < 0) return s.companies[companyId].startPrice || 100;
    const hist = s.blockHistory[s.currentBlockIndex];
    if (hist && hist.startPrices && hist.startPrices[companyId]) return hist.startPrices[companyId];
    if (s._inProgressStartPrices && s._inProgressStartPrices[companyId]) return s._inProgressStartPrices[companyId];
    return s.companies[companyId].startPrice || s.companies[companyId].price || 100;
  }

  _currentSeasonalMovePct(companyId) {
    const s = this.state;
    const block = s.currentBlockIndex >= 0 ? s.calendar[s.currentBlockIndex] : null;
    if (!block || !Array.isArray(block.moves)) return 0;
    const move = block.moves.find((entry) => entry.companyId === companyId);
    return Number(move?.pct || 0);
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

  createTeam(teamName, pin, teamSize) {
    if (!teamName || !pin) return { ok: false, error: 'teamName and pin required' };
    const name = String(teamName).trim();
    const size = Math.max(1, parseInt(teamSize, 10) || 1);
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
      teamSize: size,
      memberCount: size,
      cash: STARTING_CASH,
      holdings: {},
      trades: []
    };
    this.persist();
    return { ok: true, teamId };
  }

  // admin: update team name or PIN
  updateTeam(teamId, { teamName, pin, teamSize }) {
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
    if (teamSize !== undefined) {
      const size = Math.max(1, parseInt(teamSize, 10) || 1);
      team.teamSize = size;
      team.memberCount = size;
    }
    this.persist();
    return { ok: true };
  }

  updateTeamCapital(teamId, newCapital) {
    const team = this.state.teams[teamId];
    if (!team) return { ok: false, error: "Team not found" };
    const capital = parseFloat(newCapital);
    if (isNaN(capital)) {
      return { ok: false, error: "Invalid capital amount" };
    }
    team.cash = capital;
    this.persist();
    this._broadcastLeaderboard();
    return { ok: true };
  }

  removeTeam(teamId) {
    if (!this.state.teams[teamId]) return { ok: false, error: 'Team not found' };
    delete this.state.teams[teamId];
    this.persist();
    this._broadcastLeaderboard();
    return { ok: true };
  }

  _getHoldingBreakdown(team, companyId) {
    const raw = team.holdings[companyId];
    if (typeof raw === 'number') {
      if (raw < 0) return { long: 0, short: Math.abs(raw) };
      return { long: raw, short: 0 };
    }
    if (raw && typeof raw === 'object') {
      return {
        long: Math.max(0, parseInt(raw.long || 0, 10)),
        short: Math.max(0, parseInt(raw.short || 0, 10))
      };
    }
    return { long: 0, short: 0 };
  }

  _setHoldingBreakdown(team, companyId, { long, short }) {
    const normalizedLong = Math.max(0, parseInt(long, 10) || 0);
    const normalizedShort = Math.max(0, parseInt(short, 10) || 0);
    if (!normalizedLong && !normalizedShort) {
      delete team.holdings[companyId];
      return;
    }
    team.holdings[companyId] = { long: normalizedLong, short: normalizedShort };
  }

  _getCompanyLongHoldings(companyId) {
    const company = this.state.companies[companyId];
    if (!company) return 0;
    let total = Number(this.state.adminHoldings[companyId] || 0);
    Object.values(this.state.teams).forEach((team) => {
      const { long } = this._getHoldingBreakdown(team, companyId);
      total += long;
    });
    return total;
  }

  getTeamPortfolio(teamId) {
    const team = this.state.teams[teamId];
    if (!team) return null;
    const holdings = Object.keys(team.holdings).map((companyId) => {
      const company = this.state.companies[companyId];
      const { long, short } = this._getHoldingBreakdown(team, companyId);
      const netQty = long - short;
      const currentPrice = Math.round(company.price * 100) / 100;
      const value = Math.round(netQty * currentPrice * 100) / 100;
      return {
        companyId,
        name: company.name,
        icon: company.icon,
        boughtQty: long,
        shortedQty: short,
        netQty,
        currentPrice,
        value
      };
    });
    const holdingsValue = holdings.reduce((a, h) => a + h.value, 0);
    return {
      teamId: team.teamId,
      teamName: team.teamName,
      teamSize: team.teamSize || team.memberCount || 1,
      memberCount: team.memberCount || team.teamSize || 1,
      cash: Math.round(team.cash * 100) / 100,
      holdings,
      holdingsValue: Math.round(holdingsValue * 100) / 100,
      totalValue: Math.round((team.cash + holdingsValue) * 100) / 100
    };
  }

  _applySupplyDemandPriceMove(company, action, qty) {
    if (!company || !qty || qty <= 0) return;
    const totalShares = Number(company.totalShares || 10000);
    const adminHeld = Number(this.state.adminHoldings[company.id] || 0);
    const publicFloat = Math.max(1000, totalShares - adminHeld);

    const fractionOfFloat = qty / publicFloat;
    const floatMovePct = fractionOfFloat * 100;

    // Scale trade impact with the traded share of the float.
    // Small trades barely move the price, while 50-100 share trades are visible.
    let pctMove = Math.pow(floatMovePct, 0.85);
    if (pctMove < 0.02) pctMove = 0.02;
    if (pctMove > 20) pctMove = 20;

    const seasonalPct = this._currentSeasonalMovePct(company.id);
    if (seasonalPct !== 0) {
      const seasonalStrength = Math.min(1.5, Math.abs(seasonalPct) / 20);
      const sameDirection = (action === 'buy' || action === 'buy_to_cover')
        ? seasonalPct > 0
        : (seasonalPct < 0);
      pctMove *= 1 + seasonalStrength;
      pctMove *= sameDirection ? 1.25 : 0.85;
    }

    let direction = 1;
    if (action === 'sell' || action === 'short') {
      direction = -1;
    } else if (action === 'buy' || action === 'buy_to_cover') {
      direction = 1;
    }

    const newPrice = company.price * (1 + (direction * (pctMove / 100)));
    company.price = Math.max(PRICE_FLOOR, Math.round(newPrice * 100) / 100);
  }

  _applySetup2TradePriceMove(company, action) {
    if (!this.state.setup2Active || !company) return;
    if (action !== 'buy' && action !== 'sell') return;
    const pctMove = action === 'buy' ? SETUP2_TRADE_MOVE_PCT : -SETUP2_TRADE_MOVE_PCT;
    company.price = Math.max(PRICE_FLOOR, company.price * (1 + pctMove / 100));
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
      const totalLongs = this._getCompanyLongHoldings(companyId);
      const totalShares = Number(company.totalShares || 10000);
      if (totalLongs + qty > totalShares) {
        return { ok: false, error: 'Not enough shares available' };
      }
      const cost = qty * price;
      const fee = cost * FEE_RATE;
      const total = cost + fee;
      if (team.cash < total) return { ok: false, error: 'Insufficient funds' };
      team.cash -= total;
      const { long, short } = this._getHoldingBreakdown(team, companyId);
      this._setHoldingBreakdown(team, companyId, { long: long + qty, short });
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
      const { long, short } = this._getHoldingBreakdown(team, companyId);
      if (qty > long) return { ok: false, error: 'You do not own that many shares' };
      const proceeds = qty * price;
      const fee = proceeds * FEE_RATE;
      const net = proceeds - fee;
      team.cash += net;
      this._setHoldingBreakdown(team, companyId, { long: long - qty, short });
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
      const { long, short } = this._getHoldingBreakdown(team, companyId);
      this._setHoldingBreakdown(team, companyId, { long, short: short + qty });
      team.trades.push({
        timestamp: Date.now(),
        companyId,
        action: 'short',
        qty,
        price,
        fee: Math.round(fee * 100) / 100,
        blockIndex: this.state.currentBlockIndex
      });
    } else if (action === 'buy_to_cover') {
      const { long, short } = this._getHoldingBreakdown(team, companyId);
      if (qty > short) return { ok: false, error: 'You do not have that many shorted shares' };
      const cost = qty * price;
      const fee = cost * FEE_RATE;
      const total = cost + fee;
      if (team.cash < total) return { ok: false, error: 'Insufficient funds' };
      team.cash -= total;
      this._setHoldingBreakdown(team, companyId, { long, short: short - qty });
      team.trades.push({
        timestamp: Date.now(),
        companyId,
        action: 'buy_to_cover',
        qty,
        price,
        fee: Math.round(fee * 100) / 100,
        blockIndex: this.state.currentBlockIndex
      });
    } else {
      return { ok: false, error: 'Invalid action' };
    }

    this._applySupplyDemandPriceMove(company, action, qty);
    this.persist();
    this._broadcastLeaderboard();
    this._broadcastState();
    return { ok: true, portfolio: this.getTeamPortfolio(teamId) };
  }

  // ---------- leaderboard & awards ----------
  computeLeaderboard() {
    const rows = Object.values(this.state.teams).map((team) => {
      const holdingsValue = Object.entries(team.holdings).reduce((sum, [companyId, holding]) => {
        const { long, short } = this._getHoldingBreakdown(team, companyId);
        return sum + ((long - short) * this.state.companies[companyId].price);
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
    this._broadcastState();
  }

  replaceCompanies(newCompanies) {
    const companies = {};
    newCompanies.forEach((c) => {
      const totalShares = Number(c.totalShares || 10000);
      const price = Number(c.price || 100);
      companies[c.id] = {
        id: c.id,
        name: c.name,
        icon: c.icon || '🏢',
        startPrice: price,
        price: price,
        totalShares: totalShares > 0 ? totalShares : 10000
      };
    });
    this.state.companies = companies;
    this.persist();
    this._broadcastState();
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
    this.persist();
    this._broadcastState();
    return { ok: true };
  }

  pauseGame() {
    if (this.state.status !== 'running') return { ok: false, error: 'Not running' };
    this.state.status = 'paused';
    this.state.pausedAt = Date.now();
    this._stopTicking();
    this._pushNews('⏸️ Market paused by admin.');
    this.persist();
    this._broadcastState();
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
    this.persist();
    this._broadcastState();
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
    const header = 'Team Name,Team ID,Team Size\n';
    const body = rows.map((t) => `${t.teamName},${t.teamId},${t.teamSize || t.memberCount || 1}`).join('\n');
    return header + body;
  }
}

module.exports = { GameEngine, STARTING_CASH, FEE_RATE, buildDefaultState };
