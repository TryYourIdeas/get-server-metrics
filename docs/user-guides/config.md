# Configuration

Configure the viewer and event monitor independently. The Nuxt dashboard loads `dashboard/.env`; the Node.js monitor loads `event-monitor/.env` when started through its workspace script.

## Nuxt dashboard (`dashboard/.env`)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage` | Postgres connection string used for viewer queries. |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage-test` | Database used by `npm test`. Never point it at real data: repository tests truncate `samples`, `events`, and `hosts`. |
| `EVENT_MONITOR_URL` | `http://127.0.0.1:3100` | Node.js event monitor URL. |
| `EVENT_MONITOR_TOKEN` | none | Optional shared bearer token; must match the event monitor when configured. Required when the monitor binds beyond loopback. |
| `NUXT_ADD_DEBUG_LOGS` | `false` | `true`/`1` enables viewer tracing logs. Errors are always logged. |

## Node.js event monitor (`event-monitor/.env`)

Start from `event-monitor/.env.example`.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage` | Shared Postgres database. The monitor runs schema migrations and owns database writes. |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker the monitor subscribes to. |
| `MQTT_USERNAME` | `app` | Broker user for the monitor (must have the app ACL rules). |
| `MQTT_PASSWORD` | none | Password for that broker user. |
| `HEARTBEAT_INTERVAL_MS` | `300000` | Must match the agents' heartbeat interval; a host with no message for twice this long is shown as having no recent data. |
| `RETENTION_DAYS` | `30` | Samples and events older than this many days are deleted daily and once at startup. `0` disables pruning. Invalid values fall back to 30. |
| `EVENT_MONITOR_HOST` | `127.0.0.1` | Monitor HTTP bind address. Use loopback when viewer and monitor share a machine. |
| `EVENT_MONITOR_PORT` | `3100` | Monitor HTTP port for health, check-now, deletion, and SSE proxy requests. |
| `EVENT_MONITOR_TOKEN` | none | Optional shared bearer token. Set it when binding beyond loopback, and set the same value in the viewer's `.env`. |
| `NUXT_ADD_DEBUG_LOGS` | `false` | `true`/`1` enables monitor tracing logs. Errors are always logged. |

Shell environment variables take precedence over values loaded from each app's `.env` file.

## Agent (one per machine)

See `agent/README.md` for the full table: `HOST_ID`, `MQTT_URL`, `MQTT_USERNAME` (must equal `HOST_ID`; the agent logs an error at startup if it does not), `MQTT_PASSWORD`, `HEARTBEAT_INTERVAL_MS`, `CHECK_INTERVAL_MS`, `CPU_THRESHOLD_PERCENT`, `CPU_CONSECUTIVE_CHECKS`, `MEMORY_THRESHOLD_PERCENT`, `DISK_THRESHOLD_PERCENT`, `QUEUE_LIMIT`.

## Docker (Postgres and Mosquitto)

```bash
docker/mosquitto/add-user.sh app <password>        # event monitor's broker user
docker/mosquitto/add-user.sh <HOST_ID> <password>  # one per machine; username must equal the agent's HOST_ID
docker compose up -d                               # or: npm run db:up
```

- Postgres: image `postgres:18`, container `computer-usage-db`, host port **5433**. Databases `computer-usage` (app) and `computer-usage-test` (tests) are created on the first start. The init script runs only when the volume is first created; if `computer-usage-test` is missing, run `docker compose down -v && docker compose up -d` (this deletes stored samples).
- Mosquitto: image `eclipse-mosquitto:2`, container `computer-usage-mqtt`, port **1883**, authentication required. Users live in `docker/mosquitto/passwd` (not committed); `docker/mosquitto/acl` lets the event monitor read everything and publish check requests, and lets each agent publish only its own `heartbeat`, `event`, `reading` and `status` topics and read its own `check` topic. After adding a user, `docker compose restart mosquitto`. The broker is meant for a trusted network (LAN/VPN): it has no TLS yet.
- The event monitor subscribes with a persistent session, so the broker holds messages while the monitor is down, but only after it has connected once. Start the monitor before the agents on a brand-new install, or click Check now to fetch the first reading.
- Tables are created automatically by migrations when the event monitor boots. After changing `shared/server/db/schema.ts`, run `npm run db:generate`; migration files are stored in `shared/drizzle/`.
- When the event monitor and viewer run on different machines, bind the monitor to a reachable private-network address and set `EVENT_MONITOR_TOKEN` in both apps. Keep the monitor behind a trusted network or firewall.
