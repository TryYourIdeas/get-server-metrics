# Features

- **Many machines, one dashboard** — an agent on each machine reports CPU %, memory used/total and every real disk's used/total over MQTT; a machine picker switches between them.
- **Heartbeat plus events** — each agent sends a reading every 5 minutes (stored in Postgres, tagged by host) and an immediate event when CPU, memory or a disk crosses its threshold, and again when it recovers.
- **Alerts** — thresholds are set on each agent (defaults: CPU 90% for 3 consecutive checks, memory 90%, each disk 90%). Open alerts show as a red banner; recent alerts and recoveries are listed.
- **Check now** — fetches a fresh reading from the selected machine on demand (not stored).
- **Live updates without polling** — the standalone Node.js event monitor relays readings and events to the Nuxt viewer over Server-Sent Events, and the viewer reconnects and re-syncs by itself.
- **Machine status** — online, offline (agent stopped) or no recent data; banners show when the MQTT broker or the live connection is down.
- **Multi-disk support** — one row per mount point; duplicate devices, snap/loop mounts and kernel pseudo-filesystems (`/sys`, `/proc`, `/run`, `/dev`) are ignored.
- **Live gauges** — colour-coded (green < 70%, amber ≥ 70%, red ≥ 90%).
- **History charts** — CPU, memory and first-disk usage over the last 1 hour, 24 hours or 7 days, with 0/50/100% gridlines (real sizes for memory and disk) and the current reading in the title.
- **Per-machine log deletion** — delete one machine's stored samples (including disk samples) and events without affecting other machines or removing its machine entry.
- **Separate event-monitor service** — a Node.js workspace owns MQTT ingestion, database migrations/writes, check-now publishing, and data retention; the Nuxt viewer reads PostgreSQL and proxies live updates.
- **Data retention** — samples and events older than `RETENTION_DAYS` (default 30) are deleted by the event monitor once at startup and then daily. Set `0` to keep everything.
- **Resilient transport** — QoS 1 with persistent sessions, a bounded offline queue on each agent, duplicate deliveries ignored, invalid messages logged and dropped.
- **Per-agent broker access** — each agent has its own broker user and can only publish under its own host topic.
- **Automatic schema migrations** when the event monitor starts (existing single-machine rows become host `local`).
- **Diagnostics** — structured error logs with context; optional tracing via `NUXT_ADD_DEBUG_LOGS`.
- **JSON API** — `GET /api/hosts`, `GET /api/metrics/current?host=`, `GET /api/metrics/history?range=1h|24h|7d&host=`, `GET /api/events?host=`, `POST /api/hosts/:host/check`, `DELETE /api/hosts/:host/logs`, `GET /api/stream` (SSE).
