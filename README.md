# computer-usage

System resources monitor: the `agent` app reports CPU, memory, and disk usage over MQTT; the `event-monitor` app stores readings in Postgres; and the `dashboard` app displays them.

## Apps

| Folder | App | Purpose |
|---|---|---|
| [`agent/`](./agent/) | `agent` | Runs on each monitored server and publishes its readings to MQTT. |
| [`Event monitor/`](./Event%20monitor/) | `event-monitor` | Consumes MQTT messages, validates and stores data, and relays live updates. |
| [`dashboard/`](./dashboard/) | `dashboard` | Nuxt web app that reads PostgreSQL and displays resource usage. |

Shared database and ingestion utilities are in [`shared/`](./shared/); deployment files and project-wide tests remain at the repository root.

## Quick start

```bash
docker/mosquitto/add-user.sh app <password>       # broker user for the app
docker/mosquitto/add-user.sh local <password>     # broker user for this machine's agent (username = HOST_ID)
docker compose up -d        # Postgres 18 on localhost:5433, Mosquitto on localhost:1883
npm install
# configure each app
cp 'Event monitor/.env.example' 'Event monitor/.env'
cp dashboard/.env.example dashboard/.env
npm install
npm run monitor             # terminal 1: Node.js MQTT ingestion service
npm run dev                 # terminal 2: Nuxt resource viewer at http://localhost:3000
npm run agent               # terminal 3: local server agent
npm test
```

The event monitor runs database migrations on startup. The dashboard only reads PostgreSQL and proxies monitor health, check-now requests, and the live stream.

See `docs/user-guides/` (config, manual, features), `docs/pending-tasks.md`, and the design spec in `docs/superpowers/specs/`.
