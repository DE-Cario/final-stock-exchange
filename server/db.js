// server/db.js
// Very simple file-based persistence. No external DB needed.
// Game state lives in memory while the server runs, and is flushed to
// data/gamestate.json on every meaningful change so a crash/restart doesn't
// lose progress mid-event.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'gamestate.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadState(defaultState) {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      console.error('Failed to parse saved state, starting fresh.', err);
      return defaultState;
    }
  }
  return defaultState;
}

let saveTimer = null;
function saveState(state) {
  // Debounce writes slightly so 150 teams trading at once doesn't hammer disk I/O.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error('Failed to save state:', err);
    });
  }, 250);
}

function saveStateSync(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { loadState, saveState, saveStateSync, STATE_FILE };
