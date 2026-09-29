# computer-usage: System Resources Monitor — Design

## Goal
Monitor CPU, memory and disk usage of the machine running the app. Every 60 seconds the
current values are stored in a Postgres database named `computer-usage`. A web dashboard
shows live values and history.

## Decisions (agreed)
- Monitors the **local machine** (the one running the Nuxt server).
- The app runs on the host via `npm run dev`; **only Postgres runs in Docker**
  (Docker Compose, Postgres 18), so metrics reflect the real host.
- Sampler runs **in-process** inside the Nitro server (no separate collector service).
- Stack: Nuxt 4, Vue 3, TypeScript, Tailwind, Drizzle ORM, `systeminformation`.

## Architecture
```
Nitro server
 ├─ plugins/sampler.ts        starts a 60s interval on boot; first sample immediately
 ├─ utils/collector.ts        collectMetrics(): CPU %, memory, per-mount disk (systeminformation)
 ├─ db/schema.ts, db/index.ts Drizzle schema + pg connection
 ├─ utils/repository.ts       saveSample(), getHistory(range), getLatest()
 └─ api/metrics/
     ├─ current.get.ts        live values (collected on request, not from DB)
     └─ history.get.ts        ?range=1h|24h|7d -> rows from Postgres
app/pages/index.vue           dashboard (Tailwind): gauges + history charts, auto-refresh 60s
docker-compose.yml            postgres:18, database `computer-usage`, named volume
```

### Data model
- `samples(id serial pk, ts timestamptz default now() not null index, cpu_percent real, mem_used bigint, mem_total bigint)`
- `disk_samples(id serial pk, sample_id fk -> samples on delete cascade, mount text, used bigint, total bigint)`

Disk is a child table so multiple mount points are supported. Sizes are in bytes.

### Data flow
tick -> `collectMetrics()` -> `saveSample()` (one transaction: sample + disk rows) -> log.
Dashboard -> `/api/metrics/current` (gauges) and `/api/metrics/history` (charts).

### Error handling
- A failed collect or DB write is logged with context (error, timestamp, step) and the
  tick is skipped; the interval keeps running. It never crashes the server.
- Overlapping ticks are prevented (skip if the previous one is still running).
- The interval is cleared on Nitro shutdown (`close` hook); HMR in dev must not create duplicate timers.
- History endpoint validates `range`; invalid values return 400.

### Configuration (env)
`DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/computer-usage`),
`SAMPLE_INTERVAL_MS` (default 60000), `NUXT_ADD_DEBUG_LOGS` (tracing logs).

### Testing
Vitest: collector output shape (mocked `systeminformation`), repository save/query against
the Docker Postgres, history range validation. Manual check: run `npm run dev`, wait
1–2 minutes, confirm rows in `samples` and the dashboard updating.

## Out of scope (go to docs/pending-tasks.md)
- Data retention/pruning (kept indefinitely for now; table will grow ~1.4k rows/day).
- Multiple machines, alerting/thresholds, running the app itself in Docker.

## Deliverables required by project conventions
`docs/user-guides/{config,manual,features}.md`, `docs/pending-tasks.md`, an ADR in
`web/docs/architecture/adrs` (in-process sampler decision), and updates to the four
architecture diagrams in `web/docs/architecture`.
