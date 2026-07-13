// public/js/admin.js
let adminPassword = sessionStorage.getItem('cse_admin_pw') || null;
let pollHandle = null;

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
      document.getElementById('loginError').textContent = data.error;
      return;
    }
    adminPassword = pw;
    sessionStorage.setItem('cse_admin_pw', pw);
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
  sessionStorage.removeItem('cse_admin_pw');
  document.getElementById('loginScreen').style.display = 'block';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('adminPassword').value = '';
  document.getElementById('loginError').textContent = '';
}

function enterDashboard() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
  refreshOverview();
  loadCalendar();
  loadCompanies();
  pollHandle = setInterval(refreshOverview, 4000);
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
  try {
    const res = await fetch('/api/admin/overview', { headers: authHeaders() });
    const data = await res.json();
    if (!data.ok) return;
    document.getElementById('statusBadge').textContent = data.status;
    document.getElementById('seasonBanner').textContent =
      `📅 ${data.publicState.blockLabel} (Block ${data.publicState.blockIndex + 1}/${data.publicState.totalBlocks})`;

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
  } catch (err) { /* ignore transient errors */ }
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
        <th style="border:1px solid #3c3a4f; padding:8px; text-align:right;">Holdings Value</th>        <th style="border:1px solid #3c3a4f; padding:8px; text-align:center;">Action</th>      </tr>
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
      <td style="border:1px solid #3c3a4f; padding:8px; text-align:right;">₹${team.cash.toLocaleString()}</td>
      <td style="border:1px solid #3c3a4f; padding:8px;">${holdingsText}</td>
      <td style="border:1px solid #3c3a4f; padding:8px; text-align:right;">₹${team.holdingsValue.toLocaleString()}</td>
      <td style="border:1px solid #3c3a4f; padding:8px; text-align:center;"><button class="btn-danger" onclick="kickTeam('${team.teamId}')">Kick</button></td>
    </tr>`;
  });

  html += '</tbody></table>';
  box.innerHTML = html;

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
    blockDiv.style.border = '1px solid #2c2a3f';
    blockDiv.style.borderRadius = '10px';
    blockDiv.style.padding = '10px';
    blockDiv.style.marginBottom = '10px';
    blockDiv.innerHTML = `
      <div class="flex">
        <input type="text" value="${block.label}" placeholder="Block label" onchange="calendarData[${bIdx}].label=this.value">
        <input type="number" value="${block.durationMinutes}" min="1" style="width:90px" onchange="calendarData[${bIdx}].durationMinutes=Number(this.value)">
        <span class="muted">min</span>
        <button class="btn-danger" onclick="removeBlock(${bIdx})">Remove Block</button>
      </div>
      <div id="moves-${bIdx}"></div>
      <button class="btn-secondary" onclick="addMove(${bIdx})">+ Add Move</button>
    `;
    container.appendChild(blockDiv);
    const movesDiv = blockDiv.querySelector(`#moves-${bIdx}`);
    block.moves.forEach((move, mIdx) => {
      const moveRow = document.createElement('div');
      moveRow.className = 'flex';
      moveRow.style.marginTop = '6px';
      const options = companies.map((c) =>
        `<option value="${c.id}" ${c.id === move.companyId ? 'selected' : ''}>${c.icon} ${c.name}</option>`
      ).join('');
      moveRow.innerHTML = `
        <select onchange="calendarData[${bIdx}].moves[${mIdx}].companyId=this.value">${options}</select>
        <input type="number" value="${move.pct}" style="width:80px" onchange="calendarData[${bIdx}].moves[${mIdx}].pct=Number(this.value)"> %
        <button class="btn-danger" onclick="removeMove(${bIdx},${mIdx})">x</button>
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
  companiesData.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'flex';
    row.style.marginBottom = '6px';
    row.innerHTML = `
      <input type="text" value="${c.id}" style="width:100px" placeholder="id" onchange="companiesData[${idx}].id=this.value">
      <input type="text" value="${c.icon}" style="width:50px" placeholder="icon" onchange="companiesData[${idx}].icon=this.value">
      <input type="text" value="${c.name}" placeholder="Company name" onchange="companiesData[${idx}].name=this.value">
      <input type="number" value="${c.price}" style="width:90px" placeholder="start price" onchange="companiesData[${idx}].price=Number(this.value)">
      <button class="btn-danger" onclick="removeCompany(${idx})">x</button>
    `;
    container.appendChild(row);
  });
}

function addCompany() {
  companiesData.push({ id: 'new_co_' + companiesData.length, icon: '🏢', name: 'New Company', price: 100 });
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
    if (data.ok) renderCalendarEditor();
  } catch (err) {
    document.getElementById('companiesMsg').textContent = '❌ Could not save.';
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

// auto-login if password already in session
if (adminPassword) {
  fetch('/api/admin/overview', { headers: authHeaders() })
    .then((r) => r.json())
    .then((data) => { if (data.ok) enterDashboard(); })
    .catch(() => { /* fall back to login screen */ });
}
