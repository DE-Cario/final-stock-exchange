// public/js/investor.js
let teamId = localStorage.getItem('cse_teamId') || null;
let socket = null;
let latestState = null;

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
  document.getElementById('loginError').textContent = '';
  if (!teamName || !pin) {
    document.getElementById('loginError').textContent = 'Enter both team name and PIN.';
    return;
  }
  if (!/^\d{6}$/.test(pin)) {
    document.getElementById('loginError').textContent = 'PIN must be exactly 6 digits.';
    return;
  }
  try {
    const res = await fetch('/api/investor/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamName, pin })
    });
    const data = await res.json();
    if (!data.ok) {
      document.getElementById('loginError').textContent = data.error;
      return;
    }
    teamId = data.teamId;
    localStorage.setItem('cse_teamId', teamId);
    enterGame(data.portfolio);
  } catch (err) {
    document.getElementById('loginError').textContent = 'Could not reach server.';
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
  document.getElementById('signupError').textContent = '';
  if (!teamName || !pin) {
    document.getElementById('signupError').textContent = 'Enter both team name and PIN.';
    return;
  }
  if (!/^\d{6}$/.test(pin)) {
    document.getElementById('signupError').textContent = 'PIN must be exactly 6 digits.';
    return;
  }
  try {
    const res = await fetch('/api/investor/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamName, pin })
    });
    const data = await res.json();
    if (!data.ok) {
      document.getElementById('signupError').textContent = data.error || 'Signup failed';
      return;
    }
    teamId = data.teamId;
    localStorage.setItem('cse_teamId', teamId);
    // fetch portfolio and enter game
    const pRes = await fetch(`/api/investor/portfolio/${teamId}`);
    const pData = await pRes.json();
    if (pData.ok) enterGame(pData.portfolio);
    // show confirmation/reminder
    document.getElementById('signupConfirm').style.display = 'block';
  } catch (err) {
    document.getElementById('signupError').textContent = 'Could not reach server.';
  }
}

function enterGame(portfolio) {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('gameScreen').style.display = 'block';
  document.getElementById('teamNameDisplay').textContent = portfolio.teamName;
  renderPortfolio(portfolio);
  connectSocket();
  refreshState();
  setInterval(refreshState, 4000); // fallback poll in case socket drops
}

function connectSocket() {
  socket = io();
  socket.on('state_update', (state) => { latestState = state; renderState(state); });
  socket.on('leaderboard_update', () => { refreshPortfolio(); });
}

async function refreshState() {
  try {
    const res = await fetch('/api/state');
    const state = await res.json();
    latestState = state;
    renderState(state);
  } catch (err) { /* ignore transient errors */ }
}

async function refreshPortfolio() {
  if (!teamId) return;
  try {
    const res = await fetch(`/api/investor/portfolio/${teamId}`);
    const data = await res.json();
    if (data.ok) renderPortfolio(data.portfolio);
  } catch (err) { /* ignore */ }
}

function renderState(state) {
  document.getElementById('seasonBanner').textContent = `📅 ${state.blockLabel}`;
  const timerEl = document.getElementById('timer');
  if (state.timeRemainingMs != null) {
    const totalSec = Math.ceil(state.timeRemainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  } else if (state.status === 'ended') {
    timerEl.textContent = 'ENDED';
  } else {
    timerEl.textContent = state.status === 'lobby' ? 'Not started' : '--:--';
  }

  const list = document.getElementById('companyList');
  list.innerHTML = '';
  state.companies.forEach((c) => {
    const pctClass = c.pctChangeThisBlock > 0 ? 'pct-up' : (c.pctChangeThisBlock < 0 ? 'pct-down' : 'pct-flat');
    const arrow = c.pctChangeThisBlock > 0 ? '▲' : (c.pctChangeThisBlock < 0 ? '▼' : '—');
    const row = document.createElement('div');
    row.className = 'company-row';
    row.innerHTML = `
      <div class="company-name"><span class="company-icon">${c.icon}</span> ${c.name}</div>
      <div><span class="price">₹${c.price}</span> <span class="${pctClass}">${arrow} ${Math.abs(c.pctChangeThisBlock)}%</span></div>
      <div class="trade-controls">
        <input type="number" min="1" value="1" class="qty-input" id="qty-${c.id}">
        <button class="btn-buy" onclick="trade('${c.id}','buy')" ${state.status !== 'running' ? 'disabled' : ''}>Buy</button>
        <button class="btn-sell" onclick="trade('${c.id}','sell')" ${state.status !== 'running' ? 'disabled' : ''}>Sell</button>
        <button class="btn-secondary" onclick="trade('${c.id}','short')" ${state.status !== 'running' ? 'disabled' : ''}>Short</button>
      </div>
    `;
    list.appendChild(row);
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
  document.getElementById('cashDisplay').textContent = `₹${p.cash.toLocaleString()}`;
  document.getElementById('holdingsValueDisplay').textContent = `₹${p.holdingsValue.toLocaleString()}`;
  document.getElementById('totalValueDisplay').textContent = `₹${p.totalValue.toLocaleString()}`;

  const holdingsList = document.getElementById('holdingsList');
  if (!p.holdings.length) {
    holdingsList.innerHTML = '<span class="muted">No holdings yet.</span>';
    return;
  }
  holdingsList.innerHTML = '';
  p.holdings.forEach((h) => {
    const row = document.createElement('div');
    row.className = 'flex-between';
    row.style.marginBottom = '6px';
    const qtyText = h.qty < 0 ? `x${Math.abs(h.qty)} (short)` : `x${h.qty}`;
    row.innerHTML = `<span>${h.icon} ${h.name} ${qtyText}</span><span>₹${h.value.toLocaleString()}</span>`;
    holdingsList.appendChild(row);
  });
}

async function trade(companyId, action) {
  const qty = document.getElementById(`qty-${companyId}`).value;
  try {
    const res = await fetch('/api/investor/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, companyId, action, qty })
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error, 'error');
      return;
    }
    renderPortfolio(data.portfolio);
    const actionText = action === 'buy' ? 'Bought' : action === 'sell' ? 'Sold' : 'Shorted';
    showToast(`${actionText} ${qty} share(s)!`, 'success');
  } catch (err) {
    showToast('Trade failed - check connection', 'error');
  }
}

// auto-login if we already have a saved teamId
if (teamId) {
  fetch(`/api/investor/portfolio/${teamId}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) enterGame(data.portfolio);
    })
    .catch(() => { /* fall back to login screen */ });
}
