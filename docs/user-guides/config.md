# Configuration

Copy `.env.example` to `.env` and adjust if needed. Nuxt loads `.env` automatically in `npm run dev`.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage` | Postgres connection string for the app. |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage-test` | Database used by `npm test`. Never point it at real data: the repository tests truncate `samples`. |
| `SAMPLE_INTERVAL_MS` | `60000` | Milliseconds between samples. |
| `RETENTION_DAYS` | `30` | Samples older than this many days are deleted (daily, and once at startup). `0` disables pruning. Invalid values fall back to 30. |
| `NUXT_ADD_DEBUG_LOGS` | `false` | `true`/`1` enables tracing logs (collected metrics, saved samples, skipped ticks, served history). Errors are always logged. |

## Database (Docker)

```bash
docker compose up -d      # or: npm run db:up
```

- Image `postgres:18`, container `computer-usage-db`, host port **5433** (5432 is left free for any local Postgres).
- Databases `computer-usage` (app) and `computer-usage-test` (tests) are created on the first start.
- The init script runs only when the volume is first created. If `computer-usage-test` is missing, run `docker compose down -v && docker compose up -d` (this deletes stored samples).
- Tables are created automatically by migrations when the server boots. After changing `server/db/schema.ts`, run `npm run db:generate` and commit the new SQL in `drizzle/`.
