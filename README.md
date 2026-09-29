# computer-usage

System resources monitor: samples CPU, memory and disk usage of this machine every minute into Postgres (database `computer-usage`) and shows a dashboard.

## Quick start

```bash
docker compose up -d        # Postgres 18 on localhost:5433
cp .env.example .env
npm install
npm run dev                 # http://localhost:3000
npm test
```

See `docs/user-guides/` (config, manual, features), `docs/pending-tasks.md`, and the design spec in `docs/superpowers/specs/`.
