# Features

- **Automatic sampling every 60 seconds** — CPU %, memory used/total and every real disk's used/total, stored in Postgres (`computer-usage` database).
- **Multi-disk support** — one row per mount point; duplicate devices, snap/loop mounts and kernel pseudo-filesystems (`/sys`, `/proc`, `/run`, `/dev`) are ignored.
- **Live dashboard** — colour-coded gauges (green < 70%, amber ≥ 70%, red ≥ 90%) that refresh every minute.
- **History charts** — CPU, memory and first-disk usage over the last 1 hour, 24 hours or 7 days.
- **Failure-tolerant sampler** — a failed collection or database write is logged and skipped; the next tick still runs. Overlapping ticks are skipped.
- **Automatic schema migrations** on server start.
- **Diagnostics** — structured error logs with context; optional tracing via `NUXT_ADD_DEBUG_LOGS`.
- **JSON API** — `GET /api/metrics/current`, `GET /api/metrics/history?range=1h|24h|7d`.
