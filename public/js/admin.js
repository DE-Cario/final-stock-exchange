// public/js/admin.js
let adminPassword = null;
let pollHandle = null;
let isEditingCapital = false;
// Remove passwords stored by older versions of the dashboard.
sessionStorage.removeItem('cse_admin_pw');

async function adminLogin() {
  const pw = document.getElementById('adminPassword').value;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();
    if (!data.ok) {
      document.getElementById('adminPassword').value = '';
      document.getElementById('loginError').textContent = data.error;
      return;
    }
    adminPassword = pw;
    document.getElementById('adminPassword').value = '';
    enterDashboard();
  } catch (err) {
    document.getElementById('loginError').textContent = 'Could not reach server.';
  }
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'x-admin-password': adminPassword };
}

function adminLogout() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  adminPassword = null;
  window.location.assign('/');
}

let adminSocketManager = typeof SocketManager !== 'undefined' ? new SocketManager() : null;
let adminStateCache = null;

function updateAdminTimerDisplay(publicState, statusStr) {
  if (publicState) {
    adminStateCache = { ...publicState, status: statusStr || publicState.status };
  }
  const timerEls = [document.getElementById('timer'), document.getElementById('heroTimer')].filter(Boolean);
  if (!timerEls.length) return;

  let timeText = '--:--';
  if (adminStateCache && adminStateCache.timeRemainingMs != null) {
    const totalSec = Math.ceil(adminStateCache.timeRemainingMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const formatted = `${m}:${String(s).padStart(2, '0')}`;
    timeText = adminStateCache.status === 'paused' ? `⏸️ ${formatted} (Paused)` : formatted;
  } else if (statusStr === 'ended' || (adminStateCache && adminStateCache.status === 'ended')) {
    timeText = 'ENDED';
  } else if (statusStr === 'lobby' || (adminStateCache && adminStateCache.status === 'lobby')) {
    timeText = 'Not started';
  }
  timerEls.forEach((el) => { el.textContent = timeText; });
}

setInterval(() => {
  if (adminStateCache && adminStateCache.status === 'running' && adminStateCache.timeRemainingMs > 0) {
    adminStateCache.timeRemainingMs = Math.max(0, adminStateCache.timeRemainingMs - 1000);
    updateAdminTimerDisplay();
  }
}, 1000);

function enterDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  refreshOverview();
  loadCalendar();
  loadCompanies();
  pollHandle = setInterval(refreshOverview, 4000);
  
  if (adminSocketManager) {
    adminSocketManager.on('state_update', () => refreshOverview());
    adminSocketManager.on('leaderboard_update', () => refreshOverview());
    adminSocketManager.connect();
  }
}

async function callAdmin(url, method) {
  try {
    const res = await fetch(url, { method, headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) alert(data.error || 'Action failed');
    refreshOverview();
  } catch (err) {
    alert('Request failed - check connection.');
  }
}

async function resetGame() {
  if (!confirm('This will clear all teams, trades, and progress and start a fresh lobby. Continue?')) return;
  try {
    const res = await fetch('/api/admin/game/reset', { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Reset failed'); return; }
    document.getElementById('teamsCreatedResult').innerHTML = '';
    refreshOverview();
    loadCalendar();
    loadCompanies();
    alert('Game reset to the beginning.');
  } catch (err) {
    alert('Could not reset game.');
  }
}

async function refreshOverview() {
  if (isEditingCapital) return;
  try {
    const res = await fetch('/api/admin/overview', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) return;
    const statusStr = data.status || 'lobby';
    document.querySelectorAll('#statusBadge, #statusBadgeHero').forEach(el => {
      el.textContent = statusStr;
    });

    updateAdminTimerDisplay(data.publicState, statusStr);

    document.getElementById('seasonBanner').textContent =
      `📅 ${data.publicState.blockLabel} (Block ${data.publicState.blockIndex + 1}/${data.publicState.totalBlocks})`;
    renderTickerFromState(data.publicState, document.querySelector('.ticker-track'));

    // populate surprise event company dropdown
    const select = document.getElementById('surpriseCompany');
    if (select.options.length !== data.companies.length) {
      select.innerHTML = data.companies.map((c) => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('');
    }

    // leaderboard
    const lbBox = document.getElementById('adminLeaderboard');
    const sorted = [...data.teams].sort((a, b) => b.totalValue - a.totalValue);
    lbBox.innerHTML = sorted.map((t, i) =>
      `<div class="leaderboard-row"><span><span class="rank">#${i + 1}</span> ${t.teamName}</span><span>₹${t.totalValue.toLocaleString()}</span></div>`
    ).join('') || '<p class="muted">No teams yet.</p>';

    // team holdings display
    renderTeamHoldings(data.teams, data.companies);
    renderAdminHoldingsPanel(data.adminHoldings || null, data.companies, data.teams);
  } catch (err) { /* ignore transient errors */ }
}

function renderAdminHoldingsPanel(adminPortfolio, companies, teams) {
  const box = document.getElementById('adminHoldingsBox');
  const select = document.getElementById('adminHoldingsCompany');
  if (!box || !select) return;

  const portfolio = adminPortfolio || { cash: Infinity, holdings: [] };
  const currentValue = portfolio.holdings.reduce((sum, h) => sum + h.value, 0);
  const selectedCompanyId = select.value;

  const companyMap = companies?.reduce((map, company) => {
    map[company.id] = { ...company, adminHeld: 0, teamHeld: 0 };
    return map;
  }, {}) || {};

  portfolio.holdings.forEach((h) => {
    if (companyMap[h.companyId]) {
      companyMap[h.companyId].adminHeld = Number(h.boughtQty || 0);
    }
  });

  teams?.forEach((team) => {
    team.holdings?.forEach((holding) => {
      if (!companyMap[holding.companyId]) return;
      companyMap[holding.companyId].teamHeld += Number(holding.boughtQty || 0);
    });
  });

  const companyRows = Object.values(companyMap).map((company) => {
    const totalShares = Number(company.totalShares || 10000);
    const available = Math.max(0, totalShares - company.adminHeld - company.teamHeld);
    return `
      <div style="border:1px solid #2c2a3f; border-radius:8px; padding:10px; background:#121425; display:grid; gap:4px;">
        <div><b>${company.icon} ${company.name}</b></div>
        <div>Total shares: ${totalShares.toLocaleString()}</div>
        <div>Admin held: ${company.adminHeld.toLocaleString()}</div>
        <div>Team held: ${company.teamHeld.toLocaleString()}</div>
        <div>Available for purchase: ${available.toLocaleString()}</div>
      </div>
    `;
  }).join('');

  select.innerHTML = companies?.map((c) => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('') || '';
  if (selectedCompanyId && Array.from(select.options).some((option) => option.value === selectedCompanyId)) {
    select.value = selectedCompanyId;
  } else if (select.options.length > 0) {
    select.value = select.options[0].value;
  }

  box.innerHTML = `
    <div class="muted">Cash: ₹${Number.isFinite(portfolio.cash) ? portfolio.cash.toLocaleString() : '∞'}</div>
    <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
      ${portfolio.holdings.length ? portfolio.holdings.map((h) => `<div style="border:1px solid #2c2a3f; border-radius:8px; padding:8px; background:#121425;"><b>${h.icon} ${h.name}</b><br/>Shares: ${h.boughtQty} · Value: ₹${h.value.toLocaleString()}</div>`).join('') : '<div class="muted">No admin holdings yet.</div>'}
    </div>
    <div class="muted" style="margin-top:8px;">Total holdings value: ₹${currentValue.toLocaleString()}</div>
    <div style="margin-top:12px; display:grid; gap:8px;">${companyRows}</div>
  `;
}

function renderTeamHoldings(teams, companies) {
  const box = document.getElementById('teamHoldingsBox');
  if (!teams || teams.length === 0) {
    box.innerHTML = '<p class="muted">No teams yet.</p>';
    return;
  }

  // Sort teams by total value
  const sortedTeams = [...teams].sort((a, b) => b.totalValue - a.totalValue);

  // Build table
  let html = `<table style="width:100%; border-collapse:collapse; font-size:13px;">
    <thead style="background:#1e1c2f; position:sticky; top:0;">
      <tr>
        <th style="border:1px solid #3c3a4f; padding:8px; text-align:left;">Team</th>
        <th style="border:1px solid #3c3a4f; padding:8px; text-align:right;">Cash</th>
        <th style="border:1px solid #3c3a4f; padding:8px; text-align:left;">Holdings</th>
        <th style="border:1px solid #3c3a4f; padding:8px; text-align:right;">Holdings Value</th>
        <th style="border:1px solid #3c3a4f; padding:8px; text-align:center;">Action</th>
      </tr>
    </thead>
    <tbody>`;

  sortedTeams.forEach((team) => {
    const holdingsText = team.holdings && team.holdings.length > 0
      ? team.holdings.map((h) => {
          const qty = h.qty;
          const displayQty = qty < 0 ? `x${Math.abs(qty)} (short)` : `x${qty}`;
          return `${h.icon} ${h.name} ${displayQty}`;
        }).join(' | ')
      : '<span class="muted">No holdings</span>';
    
    html += `<tr style="border-bottom:1px solid #3c3a4f;">
      <td style="border:1px solid #3c3a4f; padding:8px; font-weight:500;">${team.teamName}</td>
      <td style="border:1px solid #3c3a4f; padding:8px; text-align:right;" id="cash-${team.teamId}">
        ₹${team.cash.toLocaleString()}
      </td>
      <td style="border:1px solid #3c3a4f; padding:8px;">${holdingsText}</td>
      <td style="border:1px solid #3c3a4f; padding:8px; text-align:right;">₹${team.holdingsValue.toLocaleString()}</td>
      <td style="border:1px solid #3c3a4f; padding:8px; text-align:center;" id="action-${team.teamId}">
        <button class="btn-secondary" onclick="editCapital('${team.teamId}', ${team.cash})">Edit</button>
        <button class="btn-danger" onclick="kickTeam('${team.teamId}')">Kick</button>
      </td>
    </tr>`;
  });

  html += '</tbody></table>';
  box.innerHTML = html;

}

function editCapital(teamId, currentCapital) {
  isEditingCapital = true;
  const cashCell = document.getElementById(`cash-${teamId}`);
  const actionCell = document.getElementById(`action-${teamId}`);

  cashCell.innerHTML = `<input type="number" id="capital-input-${teamId}" value="${currentCapital}" style="width: 100px; text-align: right;">`;
  actionCell.innerHTML = `
    <button class="btn-primary" onclick="saveCapital('${teamId}')">Save</button>
    <button class="btn-secondary" onclick="cancelCapitalEdit()">Cancel</button>
  `;
}

async function saveCapital(teamId) {
  const newCapital = document.getElementById(`capital-input-${teamId}`).value;
  await updateTeamCapital(teamId, newCapital);
  isEditingCapital = false;
  refreshOverview();
}

function cancelCapitalEdit() {
  isEditingCapital = false;
  refreshOverview();
}

// ---------- team setup ----------
async function kickTeam(teamId) {
  if (!confirm('Kick this team and remove their data from the game?')) return;
  try {
    const res = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    const data = await res.json();
    if (!data.ok) { alert(data.error || 'Failed to kick team'); return; }
    refreshOverview();
  } catch (err) {
    alert('Could not remove team.');
  }
}

async function updateTeamCapital(teamId, capital) {
  try {
    const res = await fetch(`/api/admin/teams/${encodeURIComponent(teamId)}/capital`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ capital: capital })
    });
    const data = await res.json();
    if (!data.ok) { 
      alert(data.error || 'Failed to update capital'); 
      return; 
    }
  } catch (err) {
    alert('Could not update capital.');
  }
}


// ---------- surprise events ----------
async function triggerSurprise() {
  const companyId = document.getElementById('surpriseCompany').value;
  const headline = document.getElementById('surpriseHeadline').value.trim();
  const pct = document.getElementById('surprisePct').value;
  if (!companyId || !headline || pct === '') { alert('Fill in all fields.'); return; }
  try {
    const res = await fetch('/api/admin/surprise', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ companyId, headline, pct: Number(pct) })
    });
    const data = await res.json();
    if (!data.ok) { alert(data.error); return; }
    document.getElementById('surpriseHeadline').value = '';
    document.getElementById('surprisePct').value = '';
    refreshOverview();
  } catch (err) {
    alert('Could not trigger event.');
  }
}

// ---------- calendar editor ----------
let calendarData = [];

async function loadCalendar() {
  const res = await fetch('/api/admin/calendar', { headers: authHeaders() });
  const data = await res.json();
  if (data.ok) {
    calendarData = data.calendar;
    renderCalendarEditor();
  }
}

async function loadCompaniesForCalendar() {
  const res = await fetch('/api/admin/companies', { headers: authHeaders() });
  const data = await res.json();
  return data.ok ? data.companies : [];
}

async function renderCalendarEditor() {
  const companies = await loadCompaniesForCalendar();
  const container = document.getElementById('calendarEditor');
  container.innerHTML = '';
  calendarData.forEach((block, bIdx) => {
    const blockDiv = document.createElement('div');
    blockDiv.className = 'season-block';
    blockDiv.innerHTML = `
      <div class="season-block-header">
        <label>Season name
          <input type="text" value="${block.label}" placeholder="Block label" oninput="calendarData[${bIdx}].label=this.value">
        </label>
        <label>Duration (min)
          <input type="number" value="${block.durationMinutes}" min="1" oninput="calendarData[${bIdx}].durationMinutes=Number(this.value)">
        </label>
        <button class="btn-danger season-remove" title="Remove season block" onclick="removeBlock(${bIdx})">Remove</button>
      </div>
      <div class="calendar-moves-header"><span>Company affected</span><span>Change (%)</span><span></span></div>
      <div class="calendar-moves" id="moves-${bIdx}"></div>
      <button class="btn-secondary add-move" onclick="addMove(${bIdx})">+ Add price change</button>
    `;
    container.appendChild(blockDiv);
    const movesDiv = blockDiv.querySelector(`#moves-${bIdx}`);
    block.moves.forEach((move, mIdx) => {
      const moveRow = document.createElement('div');
      moveRow.className = 'calendar-move-row';
      const options = companies.map((c) =>
        `<option value="${c.id}" ${c.id === move.companyId ? 'selected' : ''}>${c.icon} ${c.name}</option>`
      ).join('');
      moveRow.innerHTML = `
        <select aria-label="Company affected" onchange="calendarData[${bIdx}].moves[${mIdx}].companyId=this.value">${options}</select>
        <input type="number" aria-label="Percentage price change" value="${move.pct}" oninput="calendarData[${bIdx}].moves[${mIdx}].pct=Number(this.value)">
        <button class="btn-danger remove-move" title="Remove price change" onclick="removeMove(${bIdx},${mIdx})">×</button>
      `;
      movesDiv.appendChild(moveRow);
    });
  });
}

function addBlock() {
  calendarData.push({ label: 'New Season', durationMinutes: 10, moves: [] });
  renderCalendarEditor();
}
function removeBlock(idx) {
  calendarData.splice(idx, 1);
  renderCalendarEditor();
}
async function addMove(bIdx) {
  const companies = await loadCompaniesForCalendar();
  calendarData[bIdx].moves.push({ companyId: companies[0] ? companies[0].id : '', pct: 10 });
  renderCalendarEditor();
}
function removeMove(bIdx, mIdx) {
  calendarData[bIdx].moves.splice(mIdx, 1);
  renderCalendarEditor();
}

async function saveCalendar() {
  try {
    const res = await fetch('/api/admin/calendar', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ calendar: calendarData })
    });
    const data = await res.json();
    document.getElementById('calendarMsg').textContent = data.ok ? '✅ Saved!' : ('❌ ' + data.error);
  } catch (err) {
    document.getElementById('calendarMsg').textContent = '❌ Could not save.';
  }
}

// ---------- companies editor ----------
let companiesData = [];

async function loadCompanies() {
  const res = await fetch('/api/admin/companies', { headers: authHeaders() });
  const data = await res.json();
  if (data.ok) {
    companiesData = data.companies;
    renderCompaniesEditor();
  }
}

function renderCompaniesEditor() {
  const container = document.getElementById('companiesEditor');
  container.innerHTML = '';
  const headings = document.createElement('div');
  headings.className = 'company-editor-headings';
  headings.innerHTML = '<span>Code</span><span>Icon</span><span>Company name</span><span>Start price (₹)</span><span>Total shares</span><span>Remove</span>';
  container.appendChild(headings);
  companiesData.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'company-editor-row';
    row.innerHTML = `
      <input class="company-id-input" type="text" value="${c.id}" aria-label="Company code" placeholder="id" oninput="companiesData[${idx}].id=this.value">
      <input class="company-icon-input" type="text" value="${c.icon}" aria-label="Company icon" placeholder="icon" oninput="companiesData[${idx}].icon=this.value">
      <input class="company-name-input" type="text" value="${c.name}" aria-label="Company name" placeholder="Company name" oninput="companiesData[${idx}].name=this.value">
      <input class="company-price-input" type="number" value="${c.price}" aria-label="Starting price in rupees" placeholder="start price" oninput="companiesData[${idx}].price=Number(this.value)">
      <input class="company-shares-input" type="number" value="${c.totalShares || 10000}" aria-label="Total shares" placeholder="shares" oninput="companiesData[${idx}].totalShares=Number(this.value)">
      <button class="btn-danger" title="Remove company" onclick="removeCompany(${idx})">×</button>
    `;
    container.appendChild(row);
  });
}

function addCompany() {
  companiesData.push({ id: 'new_co_' + companiesData.length, icon: '🏢', name: 'New Company', price: 100, totalShares: 10000 });
  renderCompaniesEditor();
}
function removeCompany(idx) {
  companiesData.splice(idx, 1);
  renderCompaniesEditor();
}

async function saveCompanies() {
  try {
    const res = await fetch('/api/admin/companies', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ companies: companiesData })
    });
    const data = await res.json();
    document.getElementById('companiesMsg').textContent = data.ok ? '✅ Saved!' : ('❌ ' + data.error);
    if (data.ok) {
      // Reload the canonical server state so every editor shows the renamed company.
      await Promise.all([loadCompanies(), renderCalendarEditor(), refreshOverview()]);
    }
  } catch (err) {
    document.getElementById('companiesMsg').textContent = '❌ Could not save.';
  }
}

async function tradeAdminHolding(action) {
  const companyId = document.getElementById('adminHoldingsCompany').value;
  const qty = document.getElementById('adminHoldingsQty').value;
  if (!companyId) return;
  try {
    const res = await fetch('/api/admin/setup2/admin-holdings', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ companyId, action, qty: Number(qty) })
    });
    const data = await res.json();
    if (data.ok) {
      refreshOverview();
      document.getElementById('adminHoldingsMsg').textContent = `✅ Admin ${action === 'buy' ? 'bought' : 'sold'} shares.`;
    } else {
      document.getElementById('adminHoldingsMsg').textContent = '❌ ' + data.error;
    }
  } catch (err) {
    document.getElementById('adminHoldingsMsg').textContent = '❌ Could not update admin holdings.';
  }
}

// ---------- awards ----------
async function loadAwards() {
  try {
    const res = await fetch('/api/admin/awards', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) return;
    const a = data.awards;
    const box = document.getElementById('awardsBox');
    box.innerHTML = `
      <p>🥇 <b>Top Investor:</b> ${a.topInvestor ? a.topInvestor.teamName + ' (₹' + a.topInvestor.totalValue.toLocaleString() + ')' : '-'}</p>
      <p>🔮 <b>Best Seasonal Read:</b> ${a.bestSeasonalRead ? a.bestSeasonalRead.teamName + ' (+₹' + a.bestSeasonalRead.total.toLocaleString() + ' profit)' : '-'}</p>
      <p>⚡ <b>Sharpest Reflexes:</b> ${a.sharpestReflexes ? a.sharpestReflexes.teamName + ' (+₹' + a.sharpestReflexes.total.toLocaleString() + ' profit)' : '-'}</p>
    `;
  } catch (err) {
    alert('Could not load awards.');
  }
}
