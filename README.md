# Campus Stock Exchange 📈

A live, multiplayer stock market simulation for college orientation/fest events. Teams invest in fictional "companies" representing campus services (canteen, WiFi, library, etc.), and prices move in real time based on a scripted event calendar, live trading activity, and admin-triggered surprise news — all synced across screens via WebSockets.

Three live views: **Investor Dashboard** (teams trade), **Admin Dashboard** (control the game), **Projector View** (big-screen ticker for the room).

## Tech Stack
Node.js, Express, Socket.IO — vanilla HTML/CSS/JS on the frontend, no build step. Game state persists to a local JSON file, no database needed.

## Getting Started

```bash
git clone <repo-url>
cd final-stock-exchange
npm install
npm start
```

Server runs at `http://localhost:3000`.

### Environment Variables

| Variable         | Default   | Description                          |
|------------------|-----------|---------------------------------------|
| `PORT`           | `3000`    | Server port                           |
| `ADMIN_PASSWORD` | `ECELL26` | Password for the admin dashboard      |
| `DATA_DIR`       | `./data`  | Where game state is saved             |



## Usage

- `/` — Landing page
- `/investor.html` — Teams sign up and trade
- `/admin.html` — Start/pause the game, edit companies & calendar, trigger surprises, export results
- `/projector.html` — Live leaderboard for display screens

Before an event, configure companies and the price-drift calendar via `server/defaultCompanies.js` / `server/defaultCalendar.js`, or edit them from the Admin dashboard.

## Project Structure

```
server/      # Express API, game logic, persistence
public/      # Frontend (investor, admin, projector views)
data/        # Auto-generated game state
```
