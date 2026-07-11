# 📈 Campus Stock Exchange

A live, browser-based stock market simulation game for college orientation events.
Teams invest virtual cash in fun, campus-themed "companies" (Canteen & Co., Library Inc.,
WiFi Networks Ltd., etc). Prices move based on a seasonal calendar (e.g. exam season →
Library stock rises) plus admin-triggered "surprise events" (e.g. "WiFi goes down").

Built as plain Node.js + Express + Socket.io + a JSON file for storage — no build step,
no database setup, no framework lock-in. Easy to read and extend in any editor
(including VS Code + Copilot).

## How it's organized

```
campus-stock-exchange/
├── server/
│   ├── index.js            # Express routes + Socket.io setup (start here to understand the API)
│   ├── gameEngine.js        # All game logic: trading, pricing, seasonal drift, awards
│   ├── db.js                 # Tiny JSON file persistence layer
│   ├── defaultCompanies.js   # Default list of 11 companies (edit here, or via Admin UI)
│   └── defaultCalendar.js    # Default DEMO seasonal calendar (edit here, or via Admin UI)
├── public/
│   ├── index.html            # Landing page with links to the 3 views
│   ├── investor.html / js/investor.js   # What each team uses on their phone
│   ├── projector.html / js/projector.js # Read-only big-screen view for the projector
│   ├── admin.html / js/admin.js         # Organizer's control dashboard
│   └── css/style.css         # Shared styling
├── data/
│   └── gamestate.json        # Auto-created on first run. Delete this to fully reset the game.
└── package.json
```

## Running it locally

```bash
cd campus-stock-exchange
npm install
npm start
```

Then open:
- `http://localhost:3000/` — landing page with links to all 3 views
- `http://localhost:3000/investor.html` — what teams use (share this URL/QR code with all teams)
- `http://localhost:3000/projector.html` — open this on the projector laptop
- `http://localhost:3000/admin.html` — your control dashboard (default password: `campus123`)

**Change the admin password** before the real event:
```bash
ADMIN_PASSWORD=yourSecretHere npm start
```

## Running it for the actual live event (important!)

For ~150 phones to reach this, the server needs to be reachable on your local network
(or the public internet). Easiest options:

1. **Same WiFi network**: run `npm start` on your laptop, find your laptop's local IP
   (e.g. `192.168.1.42`), and have teams visit `http://192.168.1.42:3000/investor.html`.
   Generate a QR code for that URL so teams can scan instead of typing.
2. **Deploy it properly** (more reliable for 150+ phones at once): deploy to Render,
   Railway, Fly.io, or similar — any of these can run a plain Node/Express app for free
   or cheap. Ask me (or Copilot) for step-by-step deploy instructions for whichever
   platform you pick.

**Test with a handful of devices before the real event** — open the investor view on
5-10 phones and run a quick mock round to make sure everything feels right.

## Editing the seasonal calendar (this is the part you said you'd update later)

You have two options:

1. **Through the Admin Dashboard** (recommended, no code needed): log in, scroll to
   "Edit Seasonal Calendar", add/edit/remove blocks and which companies move by how
   much, then click Save. This only works while the game status is `lobby` (i.e.
   before you click Start).
2. **Directly in code**: edit `server/defaultCalendar.js` — it's a plain array, fully
   commented, describing each season block's label, duration, and price moves.

Same goes for the company list — edit via Admin Dashboard or `server/defaultCompanies.js`.

## How the pricing actually works (useful if you want to tweak numbers)

- Each season block has a target % move per company over its duration. The price
  drifts there smoothly (a little bit every 3 seconds), not in one jump.
- Admin "surprise events" apply an instant % change on top of whatever the price
  currently is — capped at ±30% per event — independent of the seasonal drift.
- Trading: 1% fee on every buy/sell, no short-selling, no negative balances, price
  floor of ₹10/share so nothing can crash to zero.

All of these numbers (fee rate, max surprise %, price floor, starting cash) are
constants at the top of `server/gameEngine.js` — easy to find and change.

## Known simplifications (worth knowing before the event)

- **Awards are approximations, not perfectly rigorous finance math.** "Best Seasonal
  Read" and "Sharpest Reflexes" use simplified heuristics (see comments in
  `gameEngine.js` → `computeAwards()`). The main leaderboard (total portfolio value)
  is exact and reliable — treat the two bonus awards as fun extras, and feel free to
  eyeball/verify manually before announcing them if it matters for prizes.
- **Admin auth is a single shared password**, not individual accounts — fine for one
  organizer running the show, not meant for multiple admins with different permissions.
- **No reconnect/offline handling beyond basic polling fallback** — if a team's phone
  loses signal briefly, their data is safe (it's all server-side), they just need to
  reload the page to see fresh prices again.
- Calendar/company edits are locked once the game starts, by design (to prevent
  accidental mid-game data corruption) — restart the server to fully reset and re-edit.

## Next steps / ideas if you want to keep extending this

- Add a QR code generator for the investor login URL (handy for the event day)
- Add sound effects / animations on the projector view when a surprise event fires
- Add a "freeze trading for 10 seconds" effect on circuit-breaker-style big crashes
- Persist completed games to separate files so you can run multiple practice rounds
  without losing each one's results

Good luck with the event! 🎉
