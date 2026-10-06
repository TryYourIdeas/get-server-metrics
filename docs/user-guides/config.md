# Configuration

Copy `.env.example` to `.env` and adjust if needed. Nuxt loads `.env` automatically in `npm run dev`.

## App

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage` | Postgres connection string for the app. |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5433/computer-usage-test` | Database used by `npm test`. Never point it at real data: the repository tests truncate `samples`, `events` and `hosts`. |
| `MQTT_URL` | `mqtt://localhost:1883` | Broker the app subscribes to. |
| `MQTT_USERNAME` | `app` | Broker user for the app (must have the `app` ACL rules). |
| `MQTT_PASSWORD` | none | Password for that user. |
| `HEARTBEAT_INTERVAL_MS` | `300000` | Must match the agents' heartbeat interval; a host with no message for twice this long is shown as having no recent data. |
| `RETENTION_DAYS` | `30` | Samples and events older than this many days are deleted (daily, and once at startup). `0` disables pruning. Invalid values fall back to 30. |
| `NUXT_ADD_DEBUG_LOGS` | `false` | `true`/`1` enables tracing logs (messages ingested, saved samples, stream connections). Errors are always logged. |

Shell environment variables take precedence over `.env`, so a variable exported in your terminal (for example `MQTT_USERNAME`) overrides the file, for the app and for the agent alike.

## Agent (one per machine)

See `lib/computer-usage-agent/README.md` for the full table: `HOST_ID`, `MQTT_URL`, `MQTT_USERNAME` (must equal `HOST_ID`; the agent logs an error at startup if it does not), `MQTT_PASSWORD`, `HEARTBEAT_INTERVAL_MS`, `CHECK_INTERVAL_MS`, `CPU_THRESHOLD_PERCENT`, `CPU_CONSECUTIVE_CHECKS`, `MEMORY_THRESHOLD_PERCENT`, `DISK_THRESHOLD_PERCENT`, `QUEUE_LIMIT`.

## Docker (Postgres and Mosquitto)

```bash
docker/mosquitto/add-user.sh app <password>        # the app's broker user
docker/mosquitto/add-user.sh <HOST_ID> <password>  # one per machine; username must equal the agent's HOST_ID
docker compose up -d                               # or: npm run db:up
```

- Postgres: image `postgres:18`, container `computer-usage-db`, host port **5433**. Databases `computer-usage` (app) and `computer-usage-test` (tests) are created on the first start. The init script runs only when the volume is first created; if `computer-usage-test` is missing, run `docker compose down -v && docker compose up -d` (this deletes stored samples).
- Mosquitto: image `eclipse-mosquitto:2`, container `computer-usage-mqtt`, port **1883**, authentication required. Users live in `docker/mosquitto/passwd` (not committed); `docker/mosquitto/acl` lets the app read everything and publish check requests, and lets each agent publish only its own `heartbeat`, `event`, `reading` and `status` topics and read its own `check` topic. After adding a user, `docker compose restart mosquitto`. The broker is meant for a trusted network (LAN/VPN): it has no TLS yet.
- The app subscribes with a persistent session, so the broker holds messages while the app is down, but only after the app has connected once. Start the app before the agents on a brand-new install, or click Check now to fetch the first reading.
- Tables are created automatically by migrations when the server boots. After changing `server/db/schema.ts`, run `npm run db:generate` and commit the new SQL in `drizzle/`.
