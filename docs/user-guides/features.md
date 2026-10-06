# Features

- **Automatic sampling every 60 seconds** — CPU %, memory used/total and every real disk's used/total, stored in Postgres (`computer-usage` database).
- **Multi-disk support** — one row per mount point; duplicate devices, snap/loop mounts and kernel pseudo-filesystems (`/sys`, `/proc`, `/run`, `/dev`) are ignored.
- **Live dashboard** — colour-coded gauges (green < 70%, amber ≥ 70%, red ≥ 90%) that refresh every 5 seconds.
- **History charts** — CPU, memory and first-disk usage over the last 1 hour, 24 hours or 7 days. Charts append a new point every 5 seconds from live readings (kept in the browser only, lost on reload) and re-sync with stored 1-minute samples every minute. Each chart has 0/50/100% gridlines (with the real size beside them for memory and disk) and shows the current reading in its title, e.g. `8.0 GB / 31.0 GB (26%)`.
- **Data retention** — samples (and their disk rows) older than `RETENTION_DAYS` (default 30) are deleted once at startup and then daily, keeping the database size bounded. Set `0` to keep everything.
- **Failure-tolerant sampler** — a failed collection or database write is logged and skipped; the next tick still runs. Overlapping ticks are skipped.
- **Automatic schema migrations** on server start.
- **Diagnostics** — structured error logs with context; optional tracing via `NUXT_ADD_DEBUG_LOGS`.
- **JSON API** — `GET /api/metrics/current`, `GET /api/metrics/history?range=1h|24h|7d`.
