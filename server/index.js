// server/index.js
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { GameEngine } = require('./gameEngine');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'campus123';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000
});

const engine = new GameEngine(io);

// ============ ERROR LOGGING MIDDLEWARE ============
app.use((err, req, res, next) => {
  console.error('[ERROR]', new Date().toLocaleTimeString(), err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

// ============ REQUEST TIMEOUT HANDLER ============
app.use((req, res, next) => {
  const timeout = setTimeout(() => {
    console.warn('[TIMEOUT]', new Date().toLocaleTimeString(), req.method, req.path);
    res.status(504).json({ ok: false, error: 'Request timeout' });
  }, 30000); // 30 second timeout
  
  res.on('finish', () => clearTimeout(timeout));
  next();
});

// ============ ADMIN AUTH MIDDLEWARE ============
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) {
    console.warn('[AUTH]', new Date().toLocaleTimeString(), 'Unauthorized admin access attempt');
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ============ PUBLIC / SHARED ============
app.get('/api/state', (req, res) => {
  try {
    res.json(engine.getPublicState());
  } catch (err) {
    console.error('[API ERROR] /api/state:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch state' });
  }
});

// ============ INVESTOR ============
app.post('/api/investor/login', (req, res) => {
  try {
    const { teamName, pin } = req.body;
    if (!teamName || !pin) {
      return res.status(400).json({ ok: false, error: 'Missing teamName or pin' });
    }
    const team = engine.login(teamName, pin);
    if (!team) {
      console.warn('[LOGIN]', new Date().toLocaleTimeString(), 'Invalid credentials');
      return res.status(401).json({ ok: false, error: 'Invalid team name or PIN' });
    }
    console.log('[LOGIN]', new Date().toLocaleTimeString(), 'Team logged in:', teamName);
    res.json({ ok: true, teamId: team.teamId, portfolio: engine.getTeamPortfolio(team.teamId) });
  } catch (err) {
    console.error('[API ERROR] /api/investor/login:', err);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

app.post('/api/investor/signup', (req, res) => {
  try {
    const { teamName, pin, teamSize } = req.body;
    if (!teamName || !pin) {
      return res.status(400).json({ ok: false, error: 'Missing teamName or pin' });
    }
    const result = engine.createTeam(teamName, pin, teamSize);
    if (!result.ok) {
      console.warn('[SIGNUP]', new Date().toLocaleTimeString(), 'Signup failed:', result.error);
      return res.status(400).json(result);
    }
    console.log('[SIGNUP]', new Date().toLocaleTimeString(), 'New team created:', teamName);
    res.json({ ok: true, teamId: result.teamId });
  } catch (err) {
    console.error('[API ERROR] /api/investor/signup:', err);
    res.status(500).json({ ok: false, error: 'Signup failed' });
  }
});

app.get('/api/investor/portfolio/:teamId', (req, res) => {
  try {
    const portfolio = engine.getTeamPortfolio(req.params.teamId);
    if (!portfolio) {
      return res.status(404).json({ ok: false, error: 'Team not found' });
    }
    res.json({ ok: true, portfolio });
  } catch (err) {
    console.error('[API ERROR] /api/investor/portfolio:', err);
    res.status(500).json({ ok: false, error: 'Portfolio fetch failed' });
  }
});

app.post('/api/investor/trade', (req, res) => {
  try {
    const { teamId, companyId, action, qty } = req.body;
    if (!teamId || !companyId || !action) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    const result = engine.trade(teamId, companyId, action, qty);
    if (!result.ok) {
      console.warn('[TRADE]', new Date().toLocaleTimeString(), 'Trade failed:', result.error);
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/investor/trade:', err);
    res.status(500).json({ ok: false, error: 'Trade failed' });
  }
});

// ============ ADMIN ============
app.post('/api/admin/login', (req, res) => {
  try {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      console.warn('[ADMIN]', new Date().toLocaleTimeString(), 'Failed admin login attempt');
      return res.status(401).json({ ok: false, error: 'Wrong password' });
    }
    console.log('[ADMIN]', new Date().toLocaleTimeString(), 'Admin logged in');
    res.json({ ok: true });
  } catch (err) {
    console.error('[API ERROR] /api/admin/login:', err);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      status: engine.state.status,
      publicState: engine.getPublicState(),
      teams: Object.values(engine.state.teams).map((t) => engine.getTeamPortfolio(t.teamId)),
      calendar: engine.state.calendar,
      companies: Object.values(engine.state.companies)
    });
  } catch (err) {
    console.error('[API ERROR] /api/admin/overview:', err);
    res.status(500).json({ ok: false, error: 'Overview fetch failed' });
  }
});

// admin: edit a team's name or PIN
app.put('/api/admin/teams/:teamId', requireAdmin, (req, res) => {
  try {
    const { teamId } = req.params;
    const { teamName, pin, teamSize } = req.body;
    const result = engine.updateTeam(teamId, { teamName, pin, teamSize });
    if (!result.ok) return res.status(400).json(result);
    console.log('[ADMIN]', new Date().toLocaleTimeString(), 'Team updated:', teamId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[API ERROR] /api/admin/teams/:teamId PUT:', err);
    res.status(500).json({ ok: false, error: 'Team update failed' });
  }
});

app.delete('/api/admin/teams/:teamId', requireAdmin, (req, res) => {
  try {
    const result = engine.removeTeam(req.params.teamId);
    if (!result.ok) return res.status(400).json(result);
    console.log('[ADMIN]', new Date().toLocaleTimeString(), 'Team deleted:', req.params.teamId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[API ERROR] /api/admin/teams/:teamId DELETE:', err);
    res.status(500).json({ ok: false, error: 'Team deletion failed' });
  }
});

app.post('/api/admin/game/start', requireAdmin, (req, res) => {
  try {
    const result = engine.startGame();
    io.emit('state_update', engine.getPublicState());
    console.log('[GAME]', new Date().toLocaleTimeString(), 'Game started');
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/admin/game/start:', err);
    res.status(500).json({ ok: false, error: 'Failed to start game' });
  }
});

app.post('/api/admin/game/pause', requireAdmin, (req, res) => {
  try {
    const result = engine.pauseGame();
    io.emit('state_update', engine.getPublicState());
    console.log('[GAME]', new Date().toLocaleTimeString(), 'Game paused');
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/admin/game/pause:', err);
    res.status(500).json({ ok: false, error: 'Failed to pause game' });
  }
});

app.post('/api/admin/game/resume', requireAdmin, (req, res) => {
  try {
    const result = engine.resumeGame();
    io.emit('state_update', engine.getPublicState());
    console.log('[GAME]', new Date().toLocaleTimeString(), 'Game resumed');
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/admin/game/resume:', err);
    res.status(500).json({ ok: false, error: 'Failed to resume game' });
  }
});

app.post('/api/admin/game/advance-block', requireAdmin, (req, res) => {
  try {
    const result = engine.advanceBlock();
    io.emit('state_update', engine.getPublicState());
    console.log('[GAME]', new Date().toLocaleTimeString(), 'Block advanced');
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/admin/game/advance-block:', err);
    res.status(500).json({ ok: false, error: 'Failed to advance block' });
  }
});

app.post('/api/admin/game/end', requireAdmin, (req, res) => {
  try {
    const result = engine.endGame();
    io.emit('state_update', engine.getPublicState());
    console.log('[GAME]', new Date().toLocaleTimeString(), 'Game ended');
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/admin/game/end:', err);
    res.status(500).json({ ok: false, error: 'Failed to end game' });
  }
});

app.post('/api/admin/game/reset', requireAdmin, (req, res) => {
  try {
    const result = engine.resetGame();
    io.emit('state_update', engine.getPublicState());
    console.log('[GAME]', new Date().toLocaleTimeString(), 'Game reset');
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/admin/game/reset:', err);
    res.status(500).json({ ok: false, error: 'Failed to reset game' });
  }
});

app.post('/api/admin/surprise', requireAdmin, (req, res) => {
  try {
    const { companyId, headline, pct } = req.body;
    if (!companyId || !headline || pct === undefined) {
      return res.status(400).json({ ok: false, error: 'companyId, headline, and pct are required' });
    }
    const result = engine.triggerSurprise(companyId, headline, pct);
    console.log('[GAME]', new Date().toLocaleTimeString(), 'Surprise triggered:', headline);
    res.json(result);
  } catch (err) {
    console.error('[API ERROR] /api/admin/surprise:', err);
    res.status(500).json({ ok: false, error: 'Failed to trigger surprise' });
  }
});

app.get('/api/admin/calendar', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, calendar: engine.state.calendar });
  } catch (err) {
    console.error('[API ERROR] /api/admin/calendar GET:', err);
    res.status(500).json({ ok: false, error: 'Calendar fetch failed' });
  }
});

app.post('/api/admin/calendar', requireAdmin, (req, res) => {
  try {
    if (engine.state.status !== 'lobby') {
      return res.status(400).json({ ok: false, error: 'Cannot edit calendar after the game has started. Restart server to reset.' });
    }
    engine.replaceCalendar(req.body.calendar);
    console.log('[ADMIN]', new Date().toLocaleTimeString(), 'Calendar updated');
    res.json({ ok: true });
  } catch (err) {
    console.error('[API ERROR] /api/admin/calendar POST:', err);
    res.status(500).json({ ok: false, error: 'Calendar update failed' });
  }
});

app.get('/api/admin/companies', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, companies: Object.values(engine.state.companies) });
  } catch (err) {
    console.error('[API ERROR] /api/admin/companies GET:', err);
    res.status(500).json({ ok: false, error: 'Companies fetch failed' });
  }
});

app.post('/api/admin/companies', requireAdmin, (req, res) => {
  try {
    if (engine.state.status !== 'lobby') {
      return res.status(400).json({ ok: false, error: 'Cannot edit companies after the game has started. Restart server to reset.' });
    }
    engine.replaceCompanies(req.body.companies);
    console.log('[ADMIN]', new Date().toLocaleTimeString(), 'Companies updated');
    res.json({ ok: true });
  } catch (err) {
    console.error('[API ERROR] /api/admin/companies POST:', err);
    res.status(500).json({ ok: false, error: 'Companies update failed' });
  }
});

app.get('/api/admin/awards', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, awards: engine.computeAwards() });
  } catch (err) {
    console.error('[API ERROR] /api/admin/awards:', err);
    res.status(500).json({ ok: false, error: 'Awards computation failed' });
  }
});

app.get('/api/admin/export/results.csv', requireAdmin, (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=results.csv');
    res.send(engine.exportResultsCSV());
  } catch (err) {
    console.error('[API ERROR] /api/admin/export/results.csv:', err);
    res.status(500).json({ ok: false, error: 'Export failed' });
  }
});

app.get('/api/admin/export/teams.csv', requireAdmin, (req, res) => {
  try {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=teams.csv');
    res.send(engine.exportTeamsCSV());
  } catch (err) {
    console.error('[API ERROR] /api/admin/export/teams.csv:', err);
    res.status(500).json({ ok: false, error: 'Export failed' });
  }
});

// ============ SOCKET.IO WITH ERROR HANDLING ============
io.on('connection', (socket) => {
  console.log('[SOCKET]', new Date().toLocaleTimeString(), 'Client connected:', socket.id);
  
  socket.emit('state_update', engine.getPublicState());
  
  socket.on('disconnect', () => {
    console.log('[SOCKET]', new Date().toLocaleTimeString(), 'Client disconnected:', socket.id);
  });
  
  socket.on('error', (error) => {
    console.error('[SOCKET ERROR]', new Date().toLocaleTimeString(), socket.id, error);
  });
});

// ============ SERVER START ============
server.listen(PORT, () => {
  console.log(`\n🚀 Campus Stock Exchange server running on http://localhost:${PORT}`);
  console.log(`📝 Admin password: ${ADMIN_PASSWORD} (set ADMIN_PASSWORD env var to change)`);
  console.log(`⚙️  Process ID: ${process.pid}\n`);
});

// ============ GRACEFUL SHUTDOWN ============
process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] SIGTERM received, gracefully shutting down...');
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] SIGINT received, gracefully shutting down...');
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL ERROR]', new Date().toLocaleTimeString(), err);
  process.exit(1);
});
