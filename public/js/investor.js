// public/js/investor.js
let teamId = localStorage.getItem('cse_teamId') || null;
let socketManager = new SocketManager();
let latestState = null;
let currentPortfolio = null;
let loading = new LoadingIndicator();
let companyQtyValues = {};

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type || '');
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

async function login() {
  const teamName = document.getElementById('teamNameInput').value.trim();
  const pin = document.getElementById('pinInput').value.trim();
  const teamSize = document.getElementById('teamSizeInput').value.trim();
  document.getElementById('loginError').textContent = '';
  if (!teamName || !pin) {
    document.getElementById('loginError').textContent = 'Enter both team name and PIN.';
    return;
  }
  if (!/^\d{6}$/.test(pin)) {
    document.getElementById('loginError').textContent = 'PIN must be exactly 6 digits.';
    return;
  }
  
  loading.show();
  try {
    const res = await fetchWithTimeout('/api/investor/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamName, pin, teamSize })
    });
    const data = await res.json();
    if (!data.ok) {
      document.getElementById('loginError').textContent = data.error;
      ErrorLogger.warn('Login failed: ' + data.error);
      return;
    }
    teamId = data.teamId;
    localStorage.setItem('cse_teamId', teamId);
    ErrorLogger.info('Login successful for team: ' + teamName);
    enterGame(data.portfolio);
  } catch (err) {
    const msg = err.message || 'Could not reach server.';
    document.getElementById('loginError').textContent = msg;
    ErrorLogger.error('Login error:', err);
  } finally {
    loading.hide();
  }
}

function showSignup() {
  document.getElementById('signupBox').style.display = 'block';
}

function showLogin() {
  document.getElementById('signupBox').style.display = 'none';
}

async function signup() {
  const teamName = document.getElementById('teamNameSignup').value.trim();
  const pin = document.getElementById('pinSignup').value.trim();
  const teamSize = document.getElementById('teamSizeSignup').value.trim();
  document.getElementById('signupError').textContent = '';
  if (!teamName || !pin) {
    document.getElementById('signupError').textContent = 'Enter both team name and PIN.';
    return;
  }
  if (!/^\d{6}$/.test(pin)) {
    document.getElementById('signupError').textContent = 'PIN must be exactly 6 digits.';
    return;
  }
  
  loading.show();
  try {
    const res = await fetchWithTimeout('/api/investor/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamName, pin, teamSize })
    });
    const data = await res.json();
    if (!data.ok) {
      document.getElementById('signupError').textContent = data.error || 'Signup failed';
      ErrorLogger.warn('Signup failed: ' + (data.error || 'Unknown error'));
      return;
    }
    teamId = data.teamId;
    localStorage.setItem('cse_teamId', teamId);
    ErrorLogger.info('Signup successful for team: ' + teamName);
    
    const pRes = await fetchWithTimeout(`/api/investor/portfolio/${teamId}`);
    const pData = await pRes.json();
    if (pData.ok) enterGame(pData.portfolio);
    document.getElementById('signupConfirm').style.display = 'block';
  } catch (err) {
    const msg = err.message || 'Could not reach server.';
    document.getElementById('signupError').textContent = msg;
    ErrorLogger.error('Signup error:', err);
  } finally {
    loading.hide();
  }
}

function enterGame(portfolio) {
  currentPortfolio = portfolio;
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('gameScreen').style.display = 'block';
  document.getElementById('teamNameDisplay').textContent = portfolio.teamName;
  document.getElementById('profilePill').style.display = 'flex';
  document.getElementById('profileName').textContent = portfolio.teamName;
  document.getElementById('profileDetail').textContent = `Team size ${portfolio.teamSize || portfolio.memberCount || 1}`;
  document.getElementById('teamProfileTitle').textContent = `${portfolio.teamName} • Trading squad`;
  document.getElementById('teamProfilePill').textContent = `Members: ${portfolio.teamSize || portfolio.memberCount || 1}`;
  document.getElementById('teamMetaName').textContent = portfolio.teamName;
  document.getElementById('teamMetaMembers').textContent = portfolio.teamSize || portfolio.memberCount || 1;
  document.getElementById('teamMetaCash').textContent = `₹${portfolio.cash.toLocaleString()}`;
  renderPortfolio(portfolio);
  connectSocket();
  refreshState();
  setInterval(refreshState, 5000); // fallback poll
}

function connectSocket() {
  socketManager.on('state_update', (state) => {
    latestState = state;
    renderState(state);
  });
  socketManager.on('leaderboard_update', () => {
    refreshPortfolio();
  });
  socketManager.on('connected', () => {
    showToast('✓ Connected to server', 'success');
  });
  socketManager.on('disconnected', () => {
    showToast('⚠ Connection lost - attempting to reconnect...', 'error');
  });
  socketManager.on('connection_error', (err) => {
    ErrorLogger.error('Connection issue:', err);
  });
  socketManager.connect();
}

async function refreshState() {
  try {
    const res = await fetchWithTimeout('/api/state');
    const state = await res.json();
    latestState = state;
    renderState(state);
  } catch (err) {
    ErrorLogger.debug('State refresh error: ' + err.message);
  }
}

async function refreshPortfolio() {
  if (!teamId) return;
  try {
    const res = await fetchWithTimeout(`/api/investor/portfolio/${teamId}`);
    const data = await res.json();
    if (data.ok) renderPortfolio(data.portfolio);
  } catch (err) {
    ErrorLogger.debug('Portfolio refresh error: ' + err.message);
  }
}

function renderState(state) {
  document.getElementById('seasonBanner').textContent = `📅 ${state.blockLabel}`;
  const timerEl = document.getElementById('timer');
  if (state.timeRemainingMs != null) {
    const totalSec = Math.ceil(state.timeRemainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const formatted = `${m}:${String(s).padStart(2, '0')}`;
    timerEl.textContent = state.status === 'paused' ? `⏸️ ${formatted} (Paused)` : formatted;
  } else if (state.status === 'ended') {
    timerEl.textContent = 'ENDED';
  } else {
    timerEl.textContent = state.status === 'lobby' ? 'Not started' : '--:--';
  }

  renderTickerFromState(state, document.querySelector('.ticker-track'));

  const list = document.getElementById('companyList');
  list.querySelectorAll('.qty-input').forEach((input) => {
    const companyId = input.id.replace(/^qty-/, '');
    companyQtyValues[companyId] = input.value;
  });

  if (!state.companies || !Array.isArray(state.companies)) {
    list.innerHTML = '<div class="muted">Waiting for market data...</div>';
    return;
  }

  if (!list.querySelector('.company-row')) {
    list.innerHTML = '';
  }

  state.companies.forEach((c) => {
    const pctClass = c.pctChangeThisBlock > 0 ? 'pct-up' : (c.pctChangeThisBlock < 0 ? 'pct-down' : 'pct-flat');
    const arrow = c.pctChangeThisBlock > 0 ? '▲' : (c.pctChangeThisBlock < 0 ? '▼' : '—');
    const savedQty = companyQtyValues[c.id] !== undefined ? companyQtyValues[c.id] : '1';
    
    let row = list.querySelector(`.company-row[data-company-id="${c.id}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'company-row';
      row.setAttribute('data-company-id', c.id);
      row.innerHTML = `
        <div class="company-name"><span class="company-icon">${c.icon}</span> ${c.name}</div>
        <div><span class="price">₹${c.price}</span> <span class="${pctClass}">${arrow} ${Math.abs(c.pctChangeThisBlock)}%</span></div>
        <div class="trade-controls">
          <input type="number" min="1" value="${savedQty}" class="qty-input" id="qty-${c.id}">
          <button class="btn-buy" onclick="trade('${c.id}','buy')" ${state.status !== 'running' ? 'disabled' : ''}>Buy</button>
          <button class="btn-sell" onclick="trade('${c.id}','sell')" ${state.status !== 'running' ? 'disabled' : ''}>Sell</button>
          <button class="btn-secondary" onclick="trade('${c.id}','short')" ${state.status !== 'running' ? 'disabled' : ''}>Short</button>
          <button class="btn-secondary" onclick="trade('${c.id}','buy_to_cover')" ${state.status !== 'running' ? 'disabled' : ''}>Buy to Cover</button>
        </div>
      `;
      const qtyInput = row.querySelector('.qty-input');
      qtyInput.addEventListener('input', () => {
        companyQtyValues[c.id] = qtyInput.value;
      });
      qtyInput.addEventListener('blur', () => {
        if (!qtyInput.value || parseInt(qtyInput.value, 10) < 1) {
          qtyInput.value = '1';
          companyQtyValues[c.id] = '1';
        }
      });
      list.appendChild(row);
    } else {
      const priceSpan = row.querySelector('.price');
      if (priceSpan) priceSpan.textContent = `₹${c.price}`;
      
      const pctSpan = row.querySelector('.pct-up, .pct-down, .pct-flat');
      if (pctSpan) {
        pctSpan.className = pctClass;
        pctSpan.textContent = `${arrow} ${Math.abs(c.pctChangeThisBlock)}%`;
      }
      
      const buttons = row.querySelectorAll('button');
      buttons.forEach(btn => {
        if (state.status !== 'running') {
          btn.setAttribute('disabled', 'disabled');
        } else {
          btn.removeAttribute('disabled');
        }
      });

      const qtyInput = row.querySelector('.qty-input');
      if (qtyInput && document.activeElement !== qtyInput) {
        qtyInput.value = savedQty !== '' ? savedQty : '1';
      }
    }
  });

  const newsFeed = document.getElementById('newsFeed');
  newsFeed.innerHTML = '';
  state.news.forEach((n) => {
    const item = document.createElement('div');
    item.className = 'news-item';
    const time = new Date(n.timestamp).toLocaleTimeString();
    item.innerHTML = `<div>${n.headline}</div><div class="ts">${time}</div>`;
    newsFeed.appendChild(item);
  });

  refreshPortfolio();
}

function renderPortfolio(p) {
  currentPortfolio = p || { cash: 0, holdingsValue: 0, totalValue: 0, holdings: [] };
  const safePortfolio = currentPortfolio;
  document.getElementById('cashDisplay').textContent = `₹${(safePortfolio.cash || 0).toLocaleString()}`;
  document.getElementById('holdingsValueDisplay').textContent = `₹${(safePortfolio.holdingsValue || 0).toLocaleString()}`;
  document.getElementById('totalValueDisplay').textContent = `₹${(safePortfolio.totalValue || 0).toLocaleString()}`;
  document.getElementById('profileName').textContent = safePortfolio.teamName || 'Your team';
  document.getElementById('profileDetail').textContent = `Team size ${safePortfolio.teamSize || safePortfolio.memberCount || 1}`;
  document.getElementById('teamProfilePill').textContent = `Members: ${safePortfolio.teamSize || safePortfolio.memberCount || 1}`;
  document.getElementById('teamMetaName').textContent = safePortfolio.teamName || 'Your team';
  document.getElementById('teamMetaMembers').textContent = safePortfolio.teamSize || safePortfolio.memberCount || 1;
  document.getElementById('teamMetaCash').textContent = `₹${(safePortfolio.cash || 0).toLocaleString()}`;

  const holdingsList = document.getElementById('holdingsList');
  const holdings = Array.isArray(safePortfolio.holdings) ? safePortfolio.holdings : [];
  const boughtHoldings = holdings.filter((h) => (h.boughtQty || 0) > 0);
  const shortedHoldings = holdings.filter((h) => (h.shortedQty || 0) > 0);

  if (!boughtHoldings.length && !shortedHoldings.length) {
    holdingsList.innerHTML = '<span class="muted">No holdings yet.</span>';
    return;
  }

  const renderSection = (title, items, accentClass) => {
    if (!items.length) return '';
    const rows = items.map((h) => {
      const qty = accentClass === 'short' ? (h.shortedQty || 0) : (h.boughtQty || 0);
      const value = Number(h.value || 0);
      return `<div class="flex-between holding-row"><span>${h.icon || ''} ${h.name || 'Unknown'} <span class="holding-badge ${accentClass}">x${qty} ${accentClass === 'short' ? 'short' : 'long'}</span></span><span>₹${value.toLocaleString()}</span></div>`;
    }).join('');
    return `<div class="holdings-section"><div class="holdings-section-title">${title}</div>${rows}</div>`;
  };

  holdingsList.innerHTML = `${renderSection('Bought', boughtHoldings, 'long')}${renderSection('Shorted', shortedHoldings, 'short')}`;
}

// After updating portfolio, re-sync company controls so buy-to-cover enable state is refreshed
// without waiting for the next state update.
try {
  if (typeof latestState !== 'undefined' && latestState) renderState(latestState);
} catch (e) { /* ignore: renderState may not be defined during initial load */ }

function signOut() {
  socketManager.disconnect();
  localStorage.removeItem('cse_teamId');
  teamId = null;
  currentPortfolio = null;
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('gameScreen').style.display = 'none';
  document.getElementById('profilePill').style.display = 'none';
  document.getElementById('teamNameInput').value = '';
  document.getElementById('pinInput').value = '';
  document.getElementById('teamSizeInput').value = '4';
  document.getElementById('teamNameSignup').value = '';
  document.getElementById('pinSignup').value = '';
  document.getElementById('teamSizeSignup').value = '4';
  document.getElementById('loginError').textContent = '';
  document.getElementById('signupError').textContent = '';
  document.getElementById('signupConfirm').style.display = 'none';
  showLogin();
  ErrorLogger.info('Signed out');
}

async function trade(companyId, action) {
  const qtyInput = document.getElementById(`qty-${companyId}`);
  const rawQty = qtyInput ? qtyInput.value.trim() : '';
  const qty = parseInt(rawQty, 10);
  if (isNaN(qty) || qty < 1) {
    showToast('Please enter a valid stock quantity (at least 1)', 'error');
    return;
  }
  loading.show();
  try {
    const res = await fetchWithTimeout('/api/investor/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, companyId, action, qty })
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error, 'error');
      ErrorLogger.warn('Trade failed: ' + data.error);
      return;
    }
    currentPortfolio = data.portfolio;
    renderPortfolio(data.portfolio);
    if (latestState) renderState(latestState);
    const actionText = action === 'buy' ? 'Bought' : action === 'sell' ? 'Sold' : action === 'buy_to_cover' ? 'Bought to cover' : 'Shorted';
    showToast(`${actionText} ${qty} share(s)!`, 'success');
    ErrorLogger.info(`Trade executed: ${actionText} ${qty} of ${companyId}`);
  } catch (err) {
    const msg = err.message || 'Trade failed - check connection';
    showToast(msg, 'error');
    ErrorLogger.error('Trade error:', err);
  } finally {
    loading.hide();
  }
}

// Auto-login if we have a saved teamId
if (teamId) {
  loading.show();
  fetchWithTimeout(`/api/investor/portfolio/${teamId}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) {
        enterGame(data.portfolio);
        ErrorLogger.info('Auto-login successful');
      }
    })
    .catch((err) => {
      ErrorLogger.error('Auto-login error:', err);
    })
    .finally(() => loading.hide());
}

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.visible) {
    ErrorLogger.info('Page became visible - refreshing state');
    refreshState();
  }
});

// Handle unload
window.addEventListener('beforeunload', () => {
  socketManager.disconnect();
});

