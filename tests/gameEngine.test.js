const test = require('node:test');
const assert = require('node:assert/strict');
const { GameEngine, buildDefaultState } = require('../server/gameEngine');

test('createTeam stores the team size and exposes it in the portfolio', () => {
  const engine = new GameEngine(null);
  engine.state = buildDefaultState();

  const result = engine.createTeam('Delta Squad', '123456', 6);

  assert.equal(result.ok, true);
  const portfolio = engine.getTeamPortfolio(result.teamId);
  assert.equal(portfolio.teamSize, 6);
  assert.equal(portfolio.memberCount, 6);
});
