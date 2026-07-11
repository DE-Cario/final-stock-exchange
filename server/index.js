// server/index.js
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { GameEngine } = require('./gameEngine');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'campus123';
// ^ CHANGE THIS before the real event, or set the ADMIN_PASSWORD env var.

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const engine = new GameEngine(io);

// ---------- admin auth middleware ----------
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ============ PUBLIC / SHARED ============
app.get('/api/state', (req, res) => {
  res.json(engine.getPublicState());
});

// ============ INVESTOR ============
app.post('/api/investor/login', (req, res) => {
  const { teamName, pin } = req.body;
  const team = engine.login(teamName, pin);
  if (!team) return res.status(401).json({ ok: false, error: 'Invalid team name or PIN' });
  res.json({ ok: true, teamId: team.teamId, portfolio: engine.getTeamPortfolio(team.teamId) });
});

// create a new team (investor signup)
app.post('/api/investor/signup', (req, res) => {
  const { teamName, pin } = req.body;
  const result = engine.createTeam(teamName, pin);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, teamId: result.teamId });
});

app.get('/api/investor/portfolio/:teamId', (req, res) => {
  const portfolio = engine.getTeamPortfolio(req.params.teamId);
  if (!portfolio) return res.status(404).json({ ok: false, error: 'Team not found' });
  res.json({ ok: true, portfolio });
});

app.post('/api/investor/trade', (req, res) => {
  const { teamId, companyId, action, qty } = req.body;
  const result = engine.trade(teamId, companyId, action, qty);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

// ============ ADMIN ============
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: 'Wrong password' });
  res.json({ ok: true });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    status: engine.state.status,
    publicState: engine.getPublicState(),
    teams: Object.values(engine.state.teams).map((t) => engine.getTeamPortfolio(t.teamId)),
    calendar: engine.state.calendar,
    companies: Object.values(engine.state.companies)
  });
});

// admin: edit a team's name or PIN
app.put('/api/admin/teams/:teamId', requireAdmin, (req, res) => {
  const { teamId } = req.params;
  const { teamName, pin } = req.body;
  const result = engine.updateTeam(teamId, { teamName, pin });
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
});

app.delete('/api/admin/teams/:teamId', requireAdmin, (req, res) => {
  const result = engine.removeTeam(req.params.teamId);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
});

app.post('/api/admin/game/start', requireAdmin, (req, res) => {
  const result = engine.startGame();
  io.emit('state_update', engine.getPublicState());
  res.json(result);
});

app.post('/api/admin/game/pause', requireAdmin, (req, res) => {
  const result = engine.pauseGame();
  io.emit('state_update', engine.getPublicState());
  res.json(result);
});

app.post('/api/admin/game/resume', requireAdmin, (req, res) => {
  const result = engine.resumeGame();
  io.emit('state_update', engine.getPublicState());
  res.json(result);
});

app.post('/api/admin/game/advance-block', requireAdmin, (req, res) => {
  const result = engine.advanceBlock();
  io.emit('state_update', engine.getPublicState());
  res.json(result);
});

app.post('/api/admin/game/end', requireAdmin, (req, res) => {
  const result = engine.endGame();
  io.emit('state_update', engine.getPublicState());
  res.json(result);
});

app.post('/api/admin/game/reset', requireAdmin, (req, res) => {
  const result = engine.resetGame();
  io.emit('state_update', engine.getPublicState());
  res.json(result);
});

app.post('/api/admin/surprise', requireAdmin, (req, res) => {
  const { companyId, headline, pct } = req.body;
  if (!companyId || !headline || pct === undefined) {
    return res.status(400).json({ ok: false, error: 'companyId, headline, and pct are required' });
  }
  const result = engine.triggerSurprise(companyId, headline, pct);
  res.json(result);
});

app.get('/api/admin/calendar', requireAdmin, (req, res) => {
  res.json({ ok: true, calendar: engine.state.calendar });
});

app.post('/api/admin/calendar', requireAdmin, (req, res) => {
  if (engine.state.status !== 'lobby') {
    return res.status(400).json({ ok: false, error: 'Cannot edit calendar after the game has started. Restart server to reset.' });
  }
  engine.replaceCalendar(req.body.calendar);
  res.json({ ok: true });
});

app.get('/api/admin/companies', requireAdmin, (req, res) => {
  res.json({ ok: true, companies: Object.values(engine.state.companies) });
});

app.post('/api/admin/companies', requireAdmin, (req, res) => {
  if (engine.state.status !== 'lobby') {
    return res.status(400).json({ ok: false, error: 'Cannot edit companies after the game has started. Restart server to reset.' });
  }
  engine.replaceCompanies(req.body.companies);
  res.json({ ok: true });
});

app.get('/api/admin/awards', requireAdmin, (req, res) => {
  res.json({ ok: true, awards: engine.computeAwards() });
});

app.get('/api/admin/export/results.csv', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=results.csv');
  res.send(engine.exportResultsCSV());
});

app.get('/api/admin/export/teams.csv', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=teams.csv');
  res.send(engine.exportTeamsCSV());
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  socket.emit('state_update', engine.getPublicState());
});

server.listen(PORT, () => {
  console.log(`Campus Stock Exchange server running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD} (set ADMIN_PASSWORD env var to change)`);
});
