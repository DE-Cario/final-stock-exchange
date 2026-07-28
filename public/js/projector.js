// public/js/projector.js
let lastNewsId = null;

const socket = io();
socket.on('state_update', renderState);

fetch('/api/state').then((r) => r.json()).then(renderState);
setInterval(() => fetch('/api/state').then((r) => r.json()).then(renderState), 5000);

function renderState(state) {
  document.getElementById('seasonBanner').textContent = `📅 ${state.blockLabel} (Block ${state.blockIndex + 1} of ${state.totalBlocks})`;

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
  list.innerHTML = '';
  if (!state.companies || !Array.isArray(state.companies)) {
    list.innerHTML = '<div class="muted">Waiting for market data...</div>';
    return;
  }
  state.companies.forEach((c) => {
    const pctClass = c.pctChangeThisBlock > 0 ? 'pct-up' : (c.pctChangeThisBlock < 0 ? 'pct-down' : 'pct-flat');
    const arrow = c.pctChangeThisBlock > 0 ? '▲' : (c.pctChangeThisBlock < 0 ? '▼' : '—');
    const row = document.createElement('div');
    row.className = 'company-row';
    row.innerHTML = `
      <div class="company-name"><span class="company-icon">${c.icon}</span> ${c.name}</div>
      <div class="ticker-price">₹${c.price} <span class="${pctClass}">${arrow} ${Math.abs(c.pctChangeThisBlock)}%</span></div>
    `;
    list.appendChild(row);
  });

  const lb = document.getElementById('leaderboard');
  lb.innerHTML = '';
  state.leaderboard.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'leaderboard-row';
    div.innerHTML = `<span><span class="rank">#${i + 1}</span> ${row.teamName}</span><span>₹${row.totalValue.toLocaleString()}</span>`;
    lb.appendChild(div);
  });

  // flash breaking news banner if a new headline arrived
  if (state.news.length) {
    const newest = state.news[0];
    if (newest.id !== lastNewsId) {
      lastNewsId = newest.id;
      const banner = document.getElementById('breakingNews');
      banner.textContent = '📰 ' + newest.headline;
      banner.style.display = 'block';
      banner.classList.remove('flash-news');
      void banner.offsetWidth; // restart animation
      banner.classList.add('flash-news');
      setTimeout(() => { banner.style.display = 'none'; }, 8000);
    }
  }
}
