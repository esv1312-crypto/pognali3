# Pognali Telegram Mini App API

## What is implemented
- Express API served from the same origin as `docs/telegram`.
- Telegram Mini App `initData` signature verification on the server; never trust a client-supplied Telegram user ID.
- PostgreSQL schema for profiles, events, participants.
- API routes: `GET /api/health`, `GET/PATCH /api/me`, `GET /api/events`, `GET /api/events/:id`, `POST /api/events`, `POST /api/events/:id/join`, `POST /api/events/:id/leave`, `GET /api/my/events`.
- Capacity checks are performed inside a transaction.
- Frontend is served from `docs/telegram`.

## Run locally
1. Install Node.js 20+ and PostgreSQL.
2. `npm install`
3. Set `DATABASE_URL` and `TELEGRAM_BOT_TOKEN` in your shell.
4. `npm start`
5. Open `http://localhost:3000/api/health`.

On startup the server applies `server/schema.sql` using idempotent `CREATE TABLE IF NOT EXISTS` statements.

## Render configuration
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Required environment variables: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`.
- Keep the database in the same Render region as the web service; prefer the internal database URL.
- Configure `DATABASE_URL` using Render's secret/environment-variable UI or a database connection reference. Never put credentials in Git.

## Important current limitation
The API and database are implemented as a separate backend foundation, but the existing Telegram HTML UI still contains prototype/localStorage flows and must be wired to these endpoints before claiming a complete multi-user app. A real BotFather token and database connection must be configured on Render before production use. Do not expose a bot token in frontend code or commit history.
